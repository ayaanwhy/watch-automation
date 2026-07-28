// Shared subprocess-job orchestration for the two NDJSON-driven processing
// pipelines (Preprocessing, Ring & Bracelet) — Phase 11B.
//
// Before this extraction, preprocessHandlers.ts and ringBraceletHandlers.ts
// independently reimplemented the same ~90%: activeJob/jobStarting singleton
// guard, input/output path validation, Python resolution, spawn, incremental
// NDJSON line buffering, exit classification, image reconciliation, and the
// cancel handshake. Both runners' own docstrings say the NDJSON protocol is
// deliberately kept identical between them "so the Electron main process can
// parse both with the same conventions" — this module is that one parser.
//
// What stays per-pipeline (passed in via RunnerConfig, not shared): runner
// script resolution, CLI argument construction, the stage `config` snapshot
// written to the registry, and how a 'complete' event maps to a
// StageImageRecord — these are the only points where the two pipelines'
// wire shapes genuinely differ (see RingBraceletStartPayload's own comment
// on why its contract is kept independent of Preprocess's).
//
// Persistence guarantee (Phase 11.5D): once a runner's per-image 'complete'
// or 'error' NDJSON event has been processed here, that image's result is
// written to the batch registry before the next event is handled — not
// deferred to process close. So an unexpected interruption (crash, force
// quit, OS kill) loses at most whatever was in flight at that instant;
// every image that had already reached a terminal event is durably on disk.
// Combined with each runner's own idempotent-rerun behavior (electron_runner.py
// since Phase 11E, RingBracelet/runner.py since this phase — both skip an
// image whose expected output(s) already exist), a rerun against the same
// output directory reuses that completed work rather than redoing it. This
// guarantee is what makes a future "Resume" action a thin orchestration
// layer on top of already-durable state, rather than something that itself
// needs to reconstruct progress.
import { BrowserWindow } from 'electron'
import { access, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { resolvePreprocessingPython, validatePythonPath } from './pythonResolver'
import { updateStage } from './batchRegistry'
import { logger } from '../logger'
import { applyNdjsonEvent, classifyExit, reconcileImages, snapshotProgress } from './subprocessProtocol'
import type { StageImageRecord, StagePatch, StageType } from '../../src/types/batch'

// Comfortably larger than electron_runner.py's 2s heartbeat interval (which
// is emitted even mid-BiRefNet/SAM-inference — see its module docstring)
// and RingBracelet's typical sub-second per-image time (which needs no
// heartbeat at all — see runner.py's docstring). A genuinely alive process
// never goes this long without a single stdout line.
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000

export function notifyAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

interface JobState {
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
  watchdogTimer: ReturnType<typeof setTimeout> | null
  // Phase 11.5D — serializes every registry write this job makes (incremental
  // progress persists, plus the final close/error/timeout write) so a slow
  // read-modify-write (batchRegistry.updateStage has no locking of its own)
  // can never race a later one and silently lose an update. Every writer
  // either chains onto this (queueStageUpdate) or awaits it first before its
  // own write (close/error/timeout), so writes for one job are always
  // strictly ordered.
  persistQueue: Promise<void>
}

// ── Runner configuration (the only per-pipeline surface) ────────────────────

interface BasePayload {
  inputDir: string
  outputDir: string
  batchId?: string
  pythonPath?: string
}

export interface StartResult {
  ok: true
  jobId: string
}
export interface StartError {
  ok: false
  error: string
}

export interface DonePayload {
  jobId: string
  exitCode: number | null
  succeeded: number
  failed: number
  totalDurationMs: number
  cancelledByUser: boolean
  spawnError?: string
}

export interface RunnerConfig<TPayload extends BasePayload> {
  /** Used to build jobIds and log-line prefixes, e.g. "preprocess", "ring-bracelet". */
  label: string
  stageType: StageType
  eventChannel: string
  doneChannel: string
  alreadyRunningError: string
  noPythonError: string
  /** e.g. "Preprocessing runner" — used to build "<runnerLabel> not found: <path>". */
  runnerLabel: string
  getRunnerPath: () => string
  buildArgs: (runnerPath: string, payload: TPayload) => string[]
  buildStageConfig: (payload: TPayload) => Record<string, unknown>
  mapCompleteEvent: (event: Record<string, unknown>) => Omit<StageImageRecord, 'name'>
  inactivityTimeoutMs?: number
}

export interface SubprocessRunner<TPayload extends BasePayload> {
  start: (payload: TPayload) => Promise<StartResult | StartError>
  cancel: (jobId: string) => Promise<{ ok: boolean }>
}

export function createSubprocessRunner<TPayload extends BasePayload>(
  config: RunnerConfig<TPayload>,
): SubprocessRunner<TPayload> {
  let activeJob: JobState | null = null
  // Synchronous guard for the async startup window: set to true before the
  // first await inside start() so a concurrent call is rejected even while
  // validation / Python resolution is still in progress.
  let jobStarting = false
  const inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS

  function resetWatchdog(job: JobState): void {
    if (job.watchdogTimer) clearTimeout(job.watchdogTimer)
    job.watchdogTimer = setTimeout(() => void onInactivityTimeout(job), inactivityTimeoutMs)
  }

  // Fire-and-forget from the caller's perspective, but never actually
  // concurrent — chains onto job.persistQueue so this write only starts
  // once every earlier one (for this job) has finished, and never rejects
  // (a failed persist is logged, not thrown) so awaiting job.persistQueue
  // elsewhere always resolves. Used for incremental progress persists;
  // close/error/timeout instead await job.persistQueue and then write
  // directly, since those are each this job's own last word.
  function queueStageUpdate(job: JobState, patch: StagePatch): void {
    if (!job.batchId) return
    const batchId = job.batchId
    job.persistQueue = job.persistQueue.then(async () => {
      try {
        await updateStage(batchId, config.stageType, patch)
      } catch (err) {
        logger.warn(`${config.label} — failed to persist progress for job ${job.jobId}`, err)
      }
    })
  }

  // The watchdog NEVER terminates the process — GPU work in flight (BiRefNet/
  // SAM on MPS) must never be interrupted externally, same rationale as the
  // cooperative-only cancel handshake below. It only releases our own
  // bookkeeping slot and reports failure; the process is left to finish or
  // exit on its own. If it does eventually emit 'close', that handler reads
  // `activeJob` fresh and finds it already null (cleared here), so it no-ops
  // instead of double-reporting.
  async function onInactivityTimeout(job: JobState): Promise<void> {
    if (activeJob !== job) return // already closed/replaced
    activeJob = null

    const seconds = Math.round(inactivityTimeoutMs / 1000)
    const message = job.cancelRequested
      ? `Cancellation was requested but the process produced no further output for ${seconds}s. The job was released without being terminated, to avoid interrupting in-flight work.`
      : `Process appears unresponsive — no output for ${seconds}s. The job was released without being terminated, to avoid interrupting in-flight work.`
    logger.warn(`${config.label} — job ${job.jobId} inactivity timeout (${seconds}s); releasing without terminating the process`)

    if (job.batchId) {
      // Ensure any in-flight incremental persist lands first, so this write
      // — the job's last word — is never clobbered by a lagging one.
      await job.persistQueue
      await updateStage(job.batchId, config.stageType, { status: 'failed', error: message })
    }
    const donePayload: DonePayload = {
      jobId: job.jobId,
      exitCode: null,
      succeeded: job.succeeded,
      failed: job.failed,
      totalDurationMs: job.totalDurationMs,
      cancelledByUser: false,
      spawnError: message,
    }
    notifyAllWindows(config.doneChannel, donePayload)
  }

  async function start(payload: TPayload): Promise<StartResult | StartError> {
    if (activeJob !== null || jobStarting) {
      return { ok: false, error: config.alreadyRunningError }
    }

    jobStarting = true
    const jobId = `${config.label}-${Date.now()}`

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
            return { ok: false, error: config.noPythonError }
          }
          pythonPath = resolved
        }
      } catch (err) {
        logger.error(`${config.label}:start — python resolution error`, err)
        return { ok: false, error: 'Failed to resolve Python interpreter' }
      }

      const runnerPath = config.getRunnerPath()
      try {
        await access(runnerPath)
      } catch {
        return { ok: false, error: `${config.runnerLabel} not found: ${runnerPath}` }
      }

      // ── Spawn ──────────────────────────────────────────────────────────────
      const args = config.buildArgs(runnerPath, payload)
      let child: ChildProcess
      try {
        child = spawn(pythonPath, args, {
          // stdin is 'pipe' so cancel() can write a cooperative cancel
          // command instead of sending a signal.
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        })
      } catch (err) {
        logger.error(`${config.label}:start — spawn error`, err)
        return { ok: false, error: `Failed to spawn Python process: ${String(err)}` }
      }

      const job: JobState = {
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
        watchdogTimer: null,
        persistQueue: Promise.resolve(),
      }
      activeJob = job
      resetWatchdog(job)

      logger.info(`${config.label}:start — job ${jobId} started, python=${pythonPath}`)

      if (payload.batchId) {
        // Awaited (not fire-and-forget): start()'s result resolving is what
        // flips the renderer's job state to 'running', which immediately
        // triggers a batch refetch — that refetch must not be able to
        // outrace this write.
        await updateStage(payload.batchId, config.stageType, {
          status: 'running',
          outputDir: payload.outputDir,
          config: config.buildStageConfig(payload),
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
          logger.warn(`${config.label} — malformed NDJSON: ${line.slice(0, 120)}`)
          return
        }
        applyNdjsonEvent(job, event, config.mapCompleteEvent)
        // Phase 11.5D — persist progress as it happens, not only at process
        // close, so a crash or force-quit loses at most the one image in
        // flight rather than the whole run's progress. Only complete/error
        // events actually change imageResults; other event types (progress,
        // heartbeat, start, done) have nothing new to persist here.
        if ((event['type'] === 'complete' || event['type'] === 'error') && job.batchId) {
          const { images, counts } = snapshotProgress(job.allImages, job.imageResults)
          queueStageUpdate(job, { images, counts })
        }
        notifyAllWindows(config.eventChannel, { jobId, ...event })
      }

      child.stdout!.on('data', (chunk: Buffer) => {
        resetWatchdog(job)
        lineBuf += chunk.toString('utf-8')
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''
        for (const line of lines) processLine(line)
      })

      // Phase 11F: most of what a Python runner writes to stderr is
      // diagnostic (library deprecation notices, "Device: MPS", the
      // profiling report — deliberately routed to stderr precisely so it
      // never pollutes the NDJSON stdout stream), not an actual warning. A
      // real failure is already communicated on stdout via the 'error'/
      // 'fatal' NDJSON events, which are logged at their own appropriate
      // level elsewhere. Logging every stderr line at WARN drowned out real
      // warnings with routine diagnostic noise; debug-level keeps it
      // available for troubleshooting without doing that.
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trimEnd()
        for (const line of text.split('\n')) {
          if (line.trim()) logger.debug(`[${config.label}][stderr] ${line}`)
        }
      })

      // ── process close ────────────────────────────────────────────────────
      // Exit is the sole source of truth for completion — the process always
      // terminates on its own (cooperative cancellation, never an external
      // signal), so this handler covers every outcome including cancellation.
      child.on('close', async (code) => {
        if (activeJob !== job) return // already released by the watchdog
        activeJob = null
        if (job.watchdogTimer) clearTimeout(job.watchdogTimer)

        if (lineBuf.trim()) processLine(lineBuf)

        const { cancelledByUser, fatalError } = classifyExit(code, job.fatalError)
        job.fatalError = fatalError

        // Main-owned stage status write — awaited BEFORE notifying the
        // renderer. The renderer refetches the batch the instant it sees the
        // done event, and that refetch only ever fires once per phase
        // transition (no retry/poll); notifying first could let that refetch
        // land before this write did, permanently caching a stale status.
        if (job.batchId) {
          const status = cancelledByUser ? 'cancelled' : job.fatalError ? 'failed' : 'completed'
          const { images, counts } = reconcileImages(job.allImages, job.imageResults, cancelledByUser)
          // Ensure any in-flight incremental persist (including one just
          // queued by the processLine(lineBuf) flush above) lands first, so
          // this final, fully-reconciled write is never clobbered by a
          // lagging one racing in after it.
          await job.persistQueue
          await updateStage(job.batchId, config.stageType, {
            status,
            counts,
            images,
            error: job.fatalError,
          })
        }

        const donePayload: DonePayload = {
          jobId: job.jobId,
          exitCode: code,
          succeeded: job.succeeded,
          failed: job.failed,
          totalDurationMs: job.totalDurationMs,
          cancelledByUser,
        }
        notifyAllWindows(config.doneChannel, donePayload)

        const disposition = cancelledByUser ? 'cancelled' : `exit ${code}`
        // electronRssMb: the main process's own memory at job completion —
        // Universal Preprocessing already tracks its own (Python-side) RSS
        // per image; this is the Electron-side counterpart for the same
        // "unified diagnostics" model (Phase 11F), not a new metric family.
        logger.info(
          `${config.label} — job ${job.jobId} finished ` +
          `(${disposition}, succeeded=${job.succeeded}, failed=${job.failed})`,
          { electronRssMb: Math.round(process.memoryUsage().rss / 1_048_576) }
        )
      })

      // ── process error: spawn failure (ENOENT, permissions, etc.) ──────────
      child.on('error', async (err) => {
        logger.error(`${config.label} — process error for job ${jobId}`, err)
        if (activeJob !== job) return
        activeJob = null
        if (job.watchdogTimer) clearTimeout(job.watchdogTimer)

        if (job.batchId) {
          await job.persistQueue
          await updateStage(job.batchId, config.stageType, { status: 'failed', error: err.message })
        }

        const donePayload: DonePayload = {
          jobId: job.jobId,
          exitCode: null,
          succeeded: job.succeeded,
          failed: job.failed,
          totalDurationMs: job.totalDurationMs,
          cancelledByUser: false,
          spawnError: err.message,
        }
        notifyAllWindows(config.doneChannel, donePayload)
      })

      return { ok: true, jobId }
    } finally {
      // Always release the startup guard. On success activeJob is now set,
      // which is what future concurrent-check sees. On any failure path,
      // activeJob is still null and jobStarting === false, so a retry works.
      jobStarting = false
    }
  }

  // Cooperative cancellation only — no SIGTERM/SIGKILL. Writes a command to
  // the runner's stdin and lets it stop itself at the next safe checkpoint,
  // so any GPU kernel in flight is never interrupted. The process always
  // exits on its own; this does not wait for that exit, it only signals
  // the request.
  async function cancel(jobId: string): Promise<{ ok: boolean }> {
    if (!activeJob || activeJob.jobId !== jobId) {
      return { ok: false }
    }
    activeJob.cancelRequested = true
    try {
      activeJob.process.stdin!.write(JSON.stringify({ cmd: 'cancel' }) + '\n')
    } catch (err) {
      // Benign race: process may have exited between the activeJob check
      // above and this write. The 'close' handler will report the outcome.
      logger.warn(`${config.label}:cancel — stdin write failed for job ${jobId}: ${String(err)}`)
      return { ok: false }
    }
    logger.info(`${config.label}:cancel — cancel command sent for job ${jobId}`)
    return { ok: true }
  }

  return { start, cancel }
}
