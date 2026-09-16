// Shared job-lifecycle state machine for the two subprocess-backed
// processing pipelines (Preprocessing, Ring & Bracelet) — Phase 11C.
//
// Mirrors the Phase 11B split on the Electron side (subprocessRunner.ts +
// subprocessProtocol.ts): this hook owns everything that was ~100%
// duplicated between PreprocessingJobContext.tsx and RingBraceletJobContext.tsx
// — phase/progress/error/cancel/done state, the cancel/reset implementations,
// and the universal event reactions common to both NDJSON protocols (start,
// progress's status flip, error, fatal, cancel_requested, done's stuck-image
// reconciliation). Each pipeline supplies only what genuinely differs via
// `config`: its per-image shape, and how a 'complete' event (and any
// pipeline-only event type, e.g. Preprocessing's 'initializing'/'heartbeat')
// updates that shape.
//
// Each pipeline still owns its own Context/Provider/exported hook (see
// PreprocessingJobContext.tsx / RingBraceletJobContext.tsx) — per Phase 10's
// deliberate "keep preprocessing and asset generation cleanly separated",
// this hook only shares the state machine, not the public contract.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

export type JobPhase = 'idle' | 'running' | 'done'

// 'none' — no cancel requested yet.
// 'requested' — the user clicked Cancel; set synchronously, before the
//   cancel IPC round trip resolves, so the UI updates instantly.
// 'acknowledged' — the runner's cancel_requested NDJSON event arrived; the
//   process is still running and will stop at its next checkpoint.
export type CancelPhase = 'none' | 'requested' | 'acknowledged'

export interface ProgressState {
  total: number
  completed: number
  currentImage: string | null
  currentStage: string | null
  lastHeartbeatAt: number | null
  // Non-null while a one-time, uninterruptible model load is in progress
  // (Preprocessing's "initializing" events only — never set for Ring &
  // Bracelet, which has no such concept; always cleared harmlessly there).
  initializingStage: string | null
}

export const INITIAL_PROGRESS: ProgressState = {
  total: 0,
  completed: 0,
  currentImage: null,
  currentStage: null,
  lastHeartbeatAt: null,
  initializingStage: null,
}

export interface BaseImageState {
  name: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  error: string | null
  durationMs: number | null
}

export interface BaseDonePayload {
  jobId: string
  cancelledByUser: boolean
}

type SetProgress = (updater: (p: ProgressState) => ProgressState) => void
type SetImages<TImage> = (updater: (imgs: TImage[]) => TImage[]) => void

export interface UseSubprocessJobConfig<TImage extends BaseImageState, TStart, TDone extends BaseDonePayload> {
  startInvoke: (payload: TStart) => Promise<{ ok: true; jobId: string } | { ok: false; error: string }>
  cancelInvoke: (jobId: string) => Promise<unknown>
  /** Builds one image's initial ('pending') state from its filename. */
  buildImage: (name: string) => TImage
  /**
   * Applies an event's pipeline-specific effect. Called for EVERY event,
   * after the hook's own universal handling — 'complete' always needs this
   * (its fields differ per pipeline); pipeline-only event types
   * (Preprocessing's 'progress' → per-image `stage`, 'initializing',
   * 'heartbeat') are handled here too since the hook has no concept of them.
   */
  applyEvent: (
    event: Record<string, unknown>,
    helpers: { setProgress: SetProgress; setImages: SetImages<TImage> },
  ) => void
}

export interface SubprocessJobHandle<TImage extends BaseImageState, TStart, TDone extends BaseDonePayload> {
  phase: JobPhase
  progress: ProgressState
  images: TImage[]
  startError: string | null
  fatalError: string | null
  cancelPhase: CancelPhase
  donePayload: TDone | null
  startedAt: number | null
  // batchId of whichever job is currently active (running, or just finished
  // and not yet reset) — read off the payload passed to the `start()` call
  // that's actually in effect right now, not whatever a caller separately
  // tracks. Queueing (Item 5A) is exactly why this needed to become the
  // source of truth: when the drain effect below auto-starts the next
  // queued payload, nothing outside this hook decided to — so anything
  // that needs "which batch is this job about" (the *BatchSync components'
  // refetch-on-phase-change) must read it from here, not a prop a Console
  // set once at the original Start click.
  activeBatchId: string | null
  /** Only valid to read from inside a `window.api.on` subscription callback. */
  jobIdRef: MutableRefObject<string | null>
  // Resolves true only once the job has actually started (jobId assigned,
  // phase → 'running') — Preprocessing.tsx (Phase 10F) uses this to decide
  // whether to navigate to the dedicated workspace screen.
  start: (payload: TStart) => Promise<boolean>
  cancel: () => Promise<void>
  reset: () => void
  // Queueing (Item 5A, post-Phase-13 polish) — same-pipeline-type concurrency
  // stays unsafe (GPU/VRAM contention — see subprocessRunner.ts's own
  // per-type activeJob guard) and this hook can only ever represent one
  // active job's live progress at a time (phase/progress/images are
  // singular), so a second Start while one is already running queues rather
  // than erroring. `enqueue` appends payload to an internal FIFO; a job
  // finishing (phase → 'done') automatically drains the next one via
  // `start()`, so it picks up the normal running/progress/done lifecycle
  // exactly like any other job once its turn begins. The caller is
  // responsible for marking the backing batch's stage 'queued' in the
  // registry beforehand (this hook has no batch-registry access) — see
  // Preprocessing.tsx/EditingSetup.tsx's handleStart for the pairing.
  enqueue: (payload: TStart) => void
  // batchId of every payload currently waiting (best-effort — payloads with
  // no batchId field are simply omitted, not counted). Lets a Console show
  // "N queued" or offer to cancel one without the hook needing to know
  // anything about the batch registry itself.
  queuedBatchIds: string[]
  // Removes one not-yet-started payload from the queue (e.g. the user
  // deletes/cancels a still-queued batch from the Dashboard). No-op if that
  // batchId isn't queued (already started, or never was).
  cancelQueued: (batchId: string) => void
  /** Feed one parsed NDJSON event in — call from the pipeline's own typed `window.api.on('X:event', ...)` subscription. */
  dispatchEvent: (event: Record<string, unknown>) => void
  /** Feed the terminal done payload in — call from the pipeline's own typed `window.api.on('X:done', ...)` subscription. */
  dispatchDone: (payload: TDone) => void
}

export function useSubprocessJob<TImage extends BaseImageState, TStart, TDone extends BaseDonePayload>(
  config: UseSubprocessJobConfig<TImage, TStart, TDone>,
): SubprocessJobHandle<TImage, TStart, TDone> {
  const [phase, setPhase] = useState<JobPhase>('idle')
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS)
  const [images, setImages] = useState<TImage[]>([])
  const [startError, setStartError] = useState<string | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [cancelPhase, setCancelPhase] = useState<CancelPhase>('none')
  const [donePayload, setDonePayload] = useState<TDone | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const [queuedBatchIds, setQueuedBatchIds] = useState<string[]>([])

  const jobIdRef = useRef<string | null>(null)
  const queueRef = useRef<TStart[]>([])

  const dispatchEvent = useCallback((event: Record<string, unknown>) => {
    const type = event['type']

    if (type === 'start') {
      const names = (event['images'] as string[]) ?? []
      setProgress(p => ({ ...p, total: (event['total'] as number) ?? names.length }))
      setImages(names.map(config.buildImage))
    }
    if (type === 'progress') {
      const image = event['image'] as string
      setProgress(p => ({ ...p, currentImage: image, currentStage: (event['stage'] as string) ?? null, initializingStage: null }))
      setImages(prev =>
        prev.map(img => (img.name === image ? { ...img, status: img.status === 'pending' ? 'processing' : img.status } : img))
      )
    }
    if (type === 'error') {
      const image = event['image'] as string
      setProgress(p => ({ ...p, completed: p.completed + 1 }))
      setImages(prev =>
        prev.map(img => (img.name === image ? { ...img, status: 'failed', error: (event['error'] as string) ?? 'Unknown error' } : img))
      )
    }
    if (type === 'fatal') {
      setFatalError((event['error'] as string) ?? 'Unknown fatal error')
    }
    if (type === 'cancel_requested') {
      setCancelPhase('acknowledged')
    }
    if (type === 'complete') {
      setProgress(p => ({ ...p, completed: p.completed + 1 }))
    }

    // Pipeline-specific layer, always called last so it can build on top of
    // the universal status flip above (e.g. 'complete' setting its own
    // fields, Preprocessing's 'progress' additionally setting per-image
    // `stage`, or a pipeline-only event type like 'initializing'/'heartbeat').
    config.applyEvent(event, { setProgress, setImages })
  }, [config])

  const dispatchDone = useCallback((payload: TDone) => {
    setDonePayload(payload)
    setPhase('done')
    // Reconcile any image that never reached a terminal per-image event —
    // e.g. cooperative cancellation stops the runner between images, or a
    // fatal error ends the batch early. Without this, such images would be
    // stuck showing "processing"/"pending" forever in the grid.
    setImages(prev =>
      prev.map(img =>
        img.status === 'pending' || img.status === 'processing'
          ? {
              ...img,
              status: payload.cancelledByUser ? 'cancelled' : 'failed',
              error: payload.cancelledByUser ? null : (img.error ?? 'Not completed'),
            }
          : img
      )
    )
  }, [])

  const start = useCallback(async (payload: TStart): Promise<boolean> => {
    setStartError(null)
    setFatalError(null)
    setCancelPhase('none')
    setDonePayload(null)
    setProgress(INITIAL_PROGRESS)
    setImages([])

    const result = await config.startInvoke(payload)
    if (!result.ok) {
      setStartError(result.error)
      return false
    }
    jobIdRef.current = result.jobId
    setActiveBatchId((payload as { batchId?: string }).batchId ?? null)
    setStartedAt(Date.now())
    setPhase('running')
    return true
  }, [config])

  const cancel = useCallback(async () => {
    if (!jobIdRef.current) return
    // Set synchronously, before the IPC round trip, so the UI reflects the
    // click instantly rather than waiting on the runner's acknowledgement.
    setCancelPhase('requested')
    await config.cancelInvoke(jobIdRef.current)
  }, [config])

  function syncQueuedBatchIds() {
    setQueuedBatchIds(
      queueRef.current
        .map(p => (p as { batchId?: string }).batchId)
        .filter((id): id is string => id !== undefined),
    )
  }

  const enqueue = useCallback((payload: TStart) => {
    queueRef.current = [...queueRef.current, payload]
    syncQueuedBatchIds()
  }, [])

  const cancelQueued = useCallback((batchId: string) => {
    queueRef.current = queueRef.current.filter(p => (p as { batchId?: string }).batchId !== batchId)
    syncQueuedBatchIds()
  }, [])

  // Drains one queued payload the instant the active job frees up. Runs
  // start() directly (not through any Console-level gating) — by the time a
  // payload reached the queue, its batch was already created/validated, so
  // there's nothing left to re-check.
  useEffect(() => {
    if (phase !== 'idle' && phase !== 'done') return
    if (queueRef.current.length === 0) return
    const [next, ...rest] = queueRef.current
    queueRef.current = rest
    syncQueuedBatchIds()
    void start(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const reset = useCallback(() => {
    jobIdRef.current = null
    setPhase('idle')
    setProgress(INITIAL_PROGRESS)
    setImages([])
    setStartError(null)
    setFatalError(null)
    setCancelPhase('none')
    setDonePayload(null)
    setStartedAt(null)
    setActiveBatchId(null)
  }, [])

  return {
    phase, progress, images, startError, fatalError, cancelPhase, donePayload, startedAt, activeBatchId, jobIdRef,
    start, cancel, reset, dispatchEvent, dispatchDone,
    enqueue, queuedBatchIds, cancelQueued,
  }
}
