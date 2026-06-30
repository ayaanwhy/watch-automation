import { ipcMain, BrowserWindow, app } from 'electron'
import { access, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { resolvePreprocessingPython, validatePythonPath } from '../services/pythonResolver'
import { logger } from '../logger'
import type {
  PreprocessStartPayload,
  PreprocessStartResult,
  PreprocessDonePayload,
  PreprocessResolveResult,
} from '../../src/types/ipc'

// electron_runner.py exits with this code only when it stopped cooperatively
// at a safe checkpoint after receiving a cancel request — never as a result
// of an external signal. See electron_runner.py's module docstring.
const EXIT_CANCELLED = 3

interface ActiveJob {
  jobId: string
  process: ChildProcess
  // True once preprocess:cancel has been invoked for this job. This only
  // reflects that a cancel request was sent — it does NOT mean the job
  // actually stopped early (the runner may finish naturally before reaching
  // a checkpoint). The authoritative signal is the exit code; see 'close'.
  cancelRequested: boolean
  // Populated from the NDJSON 'done' event emitted by electron_runner.py.
  succeeded: number
  failed: number
  totalDurationMs: number
}

let activeJob: ActiveJob | null = null
// Synchronous guard for the async startup window: set to true before the
// first await inside preprocess:start so a concurrent call is rejected even
// while validation / Python resolution is still in progress.
let jobStarting = false

function notifyRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// app.getAppPath() returns <monorepo>/apps/desktop in both development and
// production source contexts. The runner lives two levels up at
// <monorepo>/preprocessing/UBG/electron_runner.py.
// NOTE: production packaging will require this to be updated when the
// preprocessing assets are bundled alongside the app.
function getRunnerPath(): string {
  return join(app.getAppPath(), '..', '..', 'preprocessing', 'UBG', 'electron_runner.py')
}

function buildArgs(runnerPath: string, payload: PreprocessStartPayload): string[] {
  const args: string[] = [
    runnerPath,
    '--input-dir', payload.inputDir,
    '--output-dir', payload.outputDir,
  ]
  if (payload.scaleFactor !== undefined)      args.push('--scale-factor',      String(payload.scaleFactor))
  if (payload.objectType !== undefined)       args.push('--object-type',       payload.objectType)
  if (payload.background !== undefined)       args.push('--background',        payload.background)
  if (payload.backgroundColorHex !== undefined) args.push('--background-color', payload.backgroundColorHex)
  if (payload.outputPpi !== undefined)        args.push('--output-ppi',        String(payload.outputPpi))
  if (payload.outputSuffix !== undefined)     args.push('--output-suffix',     payload.outputSuffix)
  if (payload.refineForeground === true)      args.push('--refine-foreground')
  if (payload.edgeMode !== undefined)         args.push('--edge-mode',         payload.edgeMode)
  if (payload.edgeStrength !== undefined)     args.push('--edge-strength',     String(payload.edgeStrength))
  if (payload.maskBlur !== undefined)         args.push('--mask-blur',         String(payload.maskBlur))
  if (payload.maskOffset !== undefined)       args.push('--mask-offset',       String(payload.maskOffset))
  if (payload.birefnetModelRoot !== undefined) args.push('--birefnet-model-root', payload.birefnetModelRoot)
  if (payload.samCheckpoint !== undefined)    args.push('--sam-checkpoint',    payload.samCheckpoint)
  return args
}

export function registerPreprocessHandlers(): void {

  // ── preprocess:start ────────────────────────────────────────────────────────
  ipcMain.handle('preprocess:start', async (
    _event,
    payload: PreprocessStartPayload,
  ): Promise<PreprocessStartResult> => {

    if (activeJob !== null || jobStarting) {
      return { ok: false, error: 'A preprocessing job is already running' }
    }

    // Claim the slot synchronously before any await so concurrent invocations
    // see jobStarting === true and are rejected without spawning a second process.
    jobStarting = true
    const jobId = `pp-${Date.now()}`

    try {
      // ── Fast path validation — runs before the slow Python resolver ────────

      // Input directory must exist and be a directory.
      try {
        const s = await stat(payload.inputDir)
        if (!s.isDirectory()) {
          return { ok: false, error: `Input path is not a directory: ${payload.inputDir}` }
        }
      } catch {
        return { ok: false, error: `Input directory not found: ${payload.inputDir}` }
      }

      // Output directory's parent must exist so the runner can create the output dir.
      try {
        const s = await stat(dirname(payload.outputDir))
        if (!s.isDirectory()) {
          return { ok: false, error: `Output parent path is not a directory: ${dirname(payload.outputDir)}` }
        }
      } catch {
        return { ok: false, error: `Output parent directory not found: ${dirname(payload.outputDir)}` }
      }

      // Resolve and validate the Python interpreter. An explicit override
      // takes precedence over auto-discovery when the renderer supplies one.
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
            return {
              ok: false,
              error: 'No suitable Python interpreter found. Ensure a Conda environment with torch, sam2, and basicsr is active.',
            }
          }
          pythonPath = resolved
        }
      } catch (err) {
        logger.error('preprocess:start — python resolution error', err)
        return { ok: false, error: 'Failed to resolve Python interpreter' }
      }

      // Verify the runner script exists before spawning.
      const runnerPath = getRunnerPath()
      try {
        await access(runnerPath)
      } catch {
        return { ok: false, error: `Preprocessing runner not found: ${runnerPath}` }
      }

      // ── Spawn ──────────────────────────────────────────────────────────────
      const args = buildArgs(runnerPath, payload)
      let child: ChildProcess
      try {
        child = spawn(pythonPath, args, {
          // stdin is 'pipe' so preprocess:cancel can write a cooperative
          // cancel command instead of sending a signal — see preprocess:cancel.
          stdio: ['pipe', 'pipe', 'pipe'],
          // Inherit the main process environment so CONDA_PREFIX and PATH are available.
          env: process.env,
        })
      } catch (err) {
        logger.error('preprocess:start — spawn error', err)
        return { ok: false, error: `Failed to spawn Python process: ${String(err)}` }
      }

      activeJob = {
        jobId,
        process: child,
        cancelRequested: false,
        succeeded: 0,
        failed: 0,
        totalDurationMs: 0,
      }

      logger.info(`preprocess:start — job ${jobId} started, python=${pythonPath}`)

      // ── stdout: incremental NDJSON parsing ────────────────────────────────
      let lineBuf = ''

      function processLine(raw: string): void {
        const line = raw.trim()
        if (!line) return
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line) as Record<string, unknown>
        } catch {
          logger.warn(`preprocess — malformed NDJSON: ${line.slice(0, 120)}`)
          return
        }
        // Capture the summary produced by the runner's own 'done' event.
        if (event['type'] === 'done' && activeJob) {
          activeJob.succeeded       = (event['succeeded']         as number) ?? 0
          activeJob.failed          = (event['failed']            as number) ?? 0
          activeJob.totalDurationMs = (event['total_duration_ms'] as number) ?? 0
        }
        notifyRenderer('preprocess:event', { jobId, ...event })
      }

      child.stdout!.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString('utf-8')
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''
        for (const line of lines) processLine(line)
      })

      // ── stderr: forward to logger ──────────────────────────────────────────
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trimEnd()
        for (const line of text.split('\n')) {
          if (line.trim()) logger.warn(`[preprocess][stderr] ${line}`)
        }
      })

      // ── process close: flush buffer and notify renderer ────────────────────
      // Exit is the sole source of truth for completion — the process always
      // terminates on its own (cooperative cancellation, never an external
      // signal), so this handler covers every outcome including cancellation.
      child.on('close', (code) => {
        const job = activeJob
        activeJob = null
        if (!job) return

        // Flush any line that arrived without a trailing newline.
        if (lineBuf.trim()) processLine(lineBuf)

        // cancelledByUser reflects what actually happened, not just what was
        // requested: only true when the runner itself reports it stopped at
        // a checkpoint (exit code EXIT_CANCELLED). A cancel request sent just
        // as the job finished naturally will not be reflected here.
        const cancelledByUser = code === EXIT_CANCELLED

        const donePayload: PreprocessDonePayload = {
          jobId:           job.jobId,
          exitCode:        code,
          succeeded:       job.succeeded,
          failed:          job.failed,
          totalDurationMs: job.totalDurationMs,
          cancelledByUser,
        }
        notifyRenderer('preprocess:done', donePayload)

        const disposition = cancelledByUser ? 'cancelled' : `exit ${code}`
        logger.info(
          `preprocess — job ${job.jobId} finished ` +
          `(${disposition}, succeeded=${job.succeeded}, failed=${job.failed})`
        )
      })

      // ── process error: spawn failure (ENOENT, permissions, etc.) ──────────
      child.on('error', (err) => {
        logger.error(`preprocess — process error for job ${jobId}`, err)
        const job = activeJob
        activeJob = null
        if (!job) return

        const donePayload: PreprocessDonePayload = {
          jobId:           job.jobId,
          exitCode:        null,
          succeeded:       job.succeeded,
          failed:          job.failed,
          totalDurationMs: job.totalDurationMs,
          cancelledByUser: false,
          spawnError:      err.message,
        }
        notifyRenderer('preprocess:done', donePayload)
      })

      return { ok: true, jobId }

    } finally {
      // Always release the startup guard. On success activeJob is now set,
      // which is what future concurrent-check sees. On any failure path,
      // activeJob is still null and jobStarting === false, so a retry works.
      jobStarting = false
    }
  })

  // ── preprocess:cancel ───────────────────────────────────────────────────────
  // Cooperative cancellation only — no SIGTERM/SIGKILL. Writes a command to
  // the runner's stdin and lets it stop itself at the next safe checkpoint
  // (between pipeline stages), so a SAM 2/BiRefNet MPS kernel in flight is
  // never interrupted. The process always exits on its own; this handler
  // does not wait for that exit, it only signals the request.
  ipcMain.handle('preprocess:cancel', async (
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
      // Benign race: process may have exited between the activeJob check
      // above and this write. The 'close' handler will report the outcome.
      logger.warn(`preprocess:cancel — stdin write failed for job ${payload.jobId}: ${String(err)}`)
      return { ok: false }
    }
    logger.info(`preprocess:cancel — cancel command sent for job ${payload.jobId}`)
    return { ok: true }
  })

  // ── preprocess:resolve-python ───────────────────────────────────────────────
  // Diagnostic channel — lets callers confirm which interpreter was resolved
  // without starting a job. Useful for settings UI (Phase 8.5C) and testing.
  ipcMain.handle('preprocess:resolve-python', async (): Promise<PreprocessResolveResult> => {
    const pythonPath = await resolvePreprocessingPython()
    return { pythonPath }
  })
}
