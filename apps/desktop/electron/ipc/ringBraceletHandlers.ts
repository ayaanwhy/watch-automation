import { ipcMain, BrowserWindow, app } from 'electron'
import { access, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { resolvePreprocessingPython, validatePythonPath } from '../services/pythonResolver'
import { updateStage } from '../services/batchRegistry'
import { logger } from '../logger'
import type {
  RingBraceletStartPayload,
  RingBraceletStartResult,
  RingBraceletDonePayload,
} from '../../src/types/ipc'
import type { StageImageRecord } from '../../src/types/batch'

// runner.py exits with this code only when it stopped cooperatively at a
// safe checkpoint after receiving a cancel request. Same convention as
// electron_runner.py — see runner.py's module docstring.
const EXIT_CANCELLED = 3

interface ActiveJob {
  jobId: string
  process: ChildProcess
  batchId: string | null
  cancelRequested: boolean
  succeeded: number
  failed: number
  totalDurationMs: number
  fatalError: string | null
  allImages: string[]
  imageResults: Map<string, Omit<StageImageRecord, 'name'>>
}

let activeJob: ActiveJob | null = null
// Same synchronous-guard pattern as preprocessHandlers.ts: set before the
// first await inside ring-bracelet:start so a concurrent call is rejected
// even while validation / Python resolution is still in progress.
let jobStarting = false

function notifyRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// preprocessing/RingBracelet is a sibling of preprocessing/UBG — same depth
// below the monorepo root as electron_runner.py, see getRunnerPath there.
function getRunnerPath(): string {
  return join(app.getAppPath(), '..', '..', 'preprocessing', 'RingBracelet', 'runner.py')
}

function buildArgs(runnerPath: string, payload: RingBraceletStartPayload): string[] {
  const args: string[] = [
    runnerPath,
    '--input-dir', payload.inputDir,
    '--output-dir', payload.outputDir,
  ]
  if (payload.splitY !== undefined) args.push('--split-y', String(payload.splitY))
  return args
}

export function registerRingBraceletHandlers(): void {

  // ── ring-bracelet:start ─────────────────────────────────────────────────────
  ipcMain.handle('ring-bracelet:start', async (
    _event,
    payload: RingBraceletStartPayload,
  ): Promise<RingBraceletStartResult> => {

    if (activeJob !== null || jobStarting) {
      return { ok: false, error: 'A Ring & Bracelet job is already running' }
    }

    jobStarting = true
    const jobId = `rb-${Date.now()}`

    try {
      // ── Fast path validation — runs before the slow Python resolver ────────

      try {
        const s = await stat(payload.inputDir)
        if (!s.isDirectory()) {
          return { ok: false, error: `Input path is not a directory: ${payload.inputDir}` }
        }
      } catch {
        return { ok: false, error: `Input directory not found: ${payload.inputDir}` }
      }

      try {
        const s = await stat(dirname(payload.outputDir))
        if (!s.isDirectory()) {
          return { ok: false, error: `Output parent path is not a directory: ${dirname(payload.outputDir)}` }
        }
      } catch {
        return { ok: false, error: `Output parent directory not found: ${dirname(payload.outputDir)}` }
      }

      // Reuses the same interpreter resolution as Preprocessing — this
      // runner's dependencies (cv2, numpy, Pillow) are a subset of what's
      // already checked for there, so a second resolver would be pure
      // duplication for no behavioral difference.
      let pythonPath: string
      try {
        if (payload.pythonPath) {
          const result = await validatePythonPath(payload.pythonPath)
          if (!result.ok) {
            return { ok: false, error: result.error }
          }
          pythonPath = payload.pythonPath
        } else {
          const resolved = await resolvePreprocessingPython()
          if (!resolved) {
            return { ok: false, error: 'No suitable Python interpreter found.' }
          }
          pythonPath = resolved
        }
      } catch (err) {
        logger.error('ring-bracelet:start — python resolution error', err)
        return { ok: false, error: 'Failed to resolve Python interpreter' }
      }

      const runnerPath = getRunnerPath()
      try {
        await access(runnerPath)
      } catch {
        return { ok: false, error: `Ring & Bracelet runner not found: ${runnerPath}` }
      }

      // ── Spawn ──────────────────────────────────────────────────────────────
      const args = buildArgs(runnerPath, payload)
      let child: ChildProcess
      try {
        child = spawn(pythonPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        })
      } catch (err) {
        logger.error('ring-bracelet:start — spawn error', err)
        return { ok: false, error: `Failed to spawn Python process: ${String(err)}` }
      }

      activeJob = {
        jobId,
        process: child,
        batchId: payload.batchId ?? null,
        cancelRequested: false,
        succeeded: 0,
        failed: 0,
        totalDurationMs: 0,
        fatalError: null,
        allImages: [],
        imageResults: new Map(),
      }

      logger.info(`ring-bracelet:start — job ${jobId} started, python=${pythonPath}`)

      if (payload.batchId) {
        // Same ordering rationale as preprocessHandlers.ts: awaited so the
        // registry write can never be outraced by the renderer's refetch.
        await updateStage(payload.batchId, 'editing', {
          status: 'running',
          outputDir: payload.outputDir,
          config: {
            product: payload.product,
            splitY: payload.splitY ?? 0.5,
          },
        })
      }

      // ── stdout: incremental NDJSON parsing ────────────────────────────────
      let lineBuf = ''

      function processLine(raw: string): void {
        const line = raw.trim()
        if (!line) return
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line) as Record<string, unknown>
        } catch {
          logger.warn(`ring-bracelet — malformed NDJSON: ${line.slice(0, 120)}`)
          return
        }
        if (event['type'] === 'done' && activeJob) {
          activeJob.succeeded       = (event['succeeded']         as number) ?? 0
          activeJob.failed          = (event['failed']            as number) ?? 0
          activeJob.totalDurationMs = (event['total_duration_ms'] as number) ?? 0
        }
        if (event['type'] === 'fatal' && activeJob) {
          activeJob.fatalError = (event['error'] as string) ?? 'Unknown fatal error'
        }
        if (event['type'] === 'start' && activeJob) {
          activeJob.allImages = (event['images'] as string[]) ?? []
        }
        if (event['type'] === 'complete' && activeJob) {
          const name = event['image'] as string
          const frontFullImage = (event['frontFullImage'] as string) ?? null
          const frontImage = (event['frontImage'] as string) ?? null
          activeJob.imageResults.set(name, {
            status: 'completed',
            // outputPath stays the single canonical path every stage sets —
            // frontFullImage is the representative "the whole asset" output;
            // frontImage (and any future named output) lives in assets only.
            outputPath: frontFullImage,
            assets: {
              ...(frontFullImage ? { frontFullImage } : {}),
              ...(frontImage ? { frontImage } : {}),
              detected: Boolean(event['detected']),
            },
            error: null,
            durationMs: (event['duration_ms'] as number) ?? null,
          })
        }
        if (event['type'] === 'error' && activeJob) {
          const name = event['image'] as string
          activeJob.imageResults.set(name, {
            status: 'failed',
            outputPath: null,
            error: (event['error'] as string) ?? 'Unknown error',
            durationMs: null,
          })
        }
        notifyRenderer('ring-bracelet:event', { jobId, ...event })
      }

      child.stdout!.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString('utf-8')
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''
        for (const line of lines) processLine(line)
      })

      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trimEnd()
        for (const line of text.split('\n')) {
          if (line.trim()) logger.warn(`[ring-bracelet][stderr] ${line}`)
        }
      })

      // ── process close ────────────────────────────────────────────────────
      child.on('close', async (code) => {
        const job = activeJob
        activeJob = null
        if (!job) return

        if (lineBuf.trim()) processLine(lineBuf)

        const cancelledByUser = code === EXIT_CANCELLED

        if (job.batchId) {
          const status = cancelledByUser ? 'cancelled' : job.fatalError ? 'failed' : 'completed'
          const images: StageImageRecord[] = job.allImages.map(name => {
            const result = job.imageResults.get(name)
            if (result) return { name, ...result }
            return {
              name,
              status: cancelledByUser ? 'cancelled' : 'failed',
              outputPath: null,
              error: cancelledByUser ? null : 'Not completed',
              durationMs: null,
            }
          })
          await updateStage(job.batchId, 'editing', {
            status,
            counts: {
              total: job.succeeded + job.failed,
              succeeded: job.succeeded,
              failed: job.failed,
              cancelled: 0,
            },
            images,
            error: job.fatalError,
          })
        }

        const donePayload: RingBraceletDonePayload = {
          jobId:           job.jobId,
          exitCode:        code,
          succeeded:       job.succeeded,
          failed:          job.failed,
          totalDurationMs: job.totalDurationMs,
          cancelledByUser,
        }
        notifyRenderer('ring-bracelet:done', donePayload)

        const disposition = cancelledByUser ? 'cancelled' : `exit ${code}`
        logger.info(
          `ring-bracelet — job ${job.jobId} finished ` +
          `(${disposition}, succeeded=${job.succeeded}, failed=${job.failed})`
        )
      })

      // ── process error: spawn failure ──────────────────────────────────────
      child.on('error', async (err) => {
        logger.error(`ring-bracelet — process error for job ${jobId}`, err)
        const job = activeJob
        activeJob = null
        if (!job) return

        if (job.batchId) {
          await updateStage(job.batchId, 'editing', { status: 'failed', error: err.message })
        }

        const donePayload: RingBraceletDonePayload = {
          jobId:           job.jobId,
          exitCode:        null,
          succeeded:       job.succeeded,
          failed:          job.failed,
          totalDurationMs: job.totalDurationMs,
          cancelledByUser: false,
          spawnError:      err.message,
        }
        notifyRenderer('ring-bracelet:done', donePayload)
      })

      return { ok: true, jobId }

    } finally {
      jobStarting = false
    }
  })

  // ── ring-bracelet:cancel ─────────────────────────────────────────────────────
  // Cooperative only, same rationale as preprocess:cancel even though there's
  // no GPU work to protect here — consistency of the cancellation contract
  // across every subprocess-backed stage.
  ipcMain.handle('ring-bracelet:cancel', async (
    _event,
    payload: { jobId: string },
  ): Promise<{ ok: boolean }> => {
    if (!activeJob || activeJob.jobId !== payload.jobId) {
      return { ok: false }
    }
    activeJob.cancelRequested = true
    try {
      activeJob.process.stdin!.write(JSON.stringify({ cmd: 'cancel' }) + '\n')
    } catch (err) {
      logger.warn(`ring-bracelet:cancel — stdin write failed for job ${payload.jobId}: ${String(err)}`)
      return { ok: false }
    }
    logger.info(`ring-bracelet:cancel — cancel command sent for job ${payload.jobId}`)
    return { ok: true }
  })
}
