import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PreprocessDonePayload, PreprocessEventPayload, PreprocessStartPayload } from '../types/ipc'

export type PreprocessingPhase = 'idle' | 'running' | 'done'

// 'none' — no cancel requested yet.
// 'requested' — the user clicked Cancel; set synchronously, before the
//   preprocess:cancel IPC round trip resolves, so the UI updates instantly.
// 'acknowledged' — the runner's cancel_requested NDJSON event arrived;
//   the process is still running and will stop at its next checkpoint.
export type CancelPhase = 'none' | 'requested' | 'acknowledged'

export interface PreprocessingProgressState {
  total: number
  completed: number
  currentImage: string | null
  currentStage: string | null
  lastHeartbeatAt: number | null
  // Non-null while a one-time, uninterruptible model load is in progress
  // (see electron_runner.py's "initializing" events). Cleared by the next
  // real per-image 'progress' event.
  initializingStage: string | null
}

const INITIAL_PROGRESS: PreprocessingProgressState = {
  total: 0,
  completed: 0,
  currentImage: null,
  currentStage: null,
  lastHeartbeatAt: null,
  initializingStage: null,
}

interface PreprocessingJobContextValue {
  phase: PreprocessingPhase
  progress: PreprocessingProgressState
  startError: string | null
  fatalError: string | null
  cancelPhase: CancelPhase
  donePayload: PreprocessDonePayload | null
  startedAt: number | null
  start(payload: PreprocessStartPayload): Promise<void>
  cancel(): Promise<void>
  reset(): void
}

const PreprocessingJobContext = createContext<PreprocessingJobContextValue | null>(null)

export function usePreprocessingJob(): PreprocessingJobContextValue {
  const ctx = useContext(PreprocessingJobContext)
  if (!ctx) throw new Error('usePreprocessingJob must be used within PreprocessingJobProvider')
  return ctx
}

interface PreprocessingJobProviderProps {
  children: ReactNode
}

// Owns the preprocess:* job lifecycle for the lifetime of the app, not the
// lifetime of whichever screen happens to be mounted. The Preprocessing
// screen is reachable via a temporary dev toggle that unmounts it when the
// user switches to Watch Processing — mounting this provider above that
// toggle (in App.tsx) lets an in-progress job's state and IPC subscription
// survive the switch, so returning to the screen reconnects to the running
// job instead of resetting to idle.
export function PreprocessingJobProvider({ children }: PreprocessingJobProviderProps) {
  const [phase, setPhase] = useState<PreprocessingPhase>('idle')
  const [progress, setProgress] = useState<PreprocessingProgressState>(INITIAL_PROGRESS)
  const [startError, setStartError] = useState<string | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [cancelPhase, setCancelPhase] = useState<CancelPhase>('none')
  const [donePayload, setDonePayload] = useState<PreprocessDonePayload | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)

  // Ref so the long-lived event subscription below can read the current
  // job id without needing to resubscribe on every start().
  const jobIdRef = useRef<string | null>(null)

  useEffect(() => {
    // Subscribe before any job can start, per the established pattern of
    // never missing the first notification.
    const offEvent = window.api.on('preprocess:event', (payload: PreprocessEventPayload) => {
      if (payload.jobId !== jobIdRef.current) return

      switch (payload.type) {
        case 'initializing':
          setProgress(p => ({ ...p, initializingStage: payload.stage }))
          break
        case 'start':
          setProgress(p => ({ ...p, total: payload.total }))
          break
        case 'progress':
          setProgress(p => ({
            ...p,
            currentImage: payload.image,
            currentStage: payload.stage,
            initializingStage: null,
          }))
          break
        case 'heartbeat':
          setProgress(p => ({ ...p, lastHeartbeatAt: Date.now() }))
          break
        case 'complete':
        case 'error':
          setProgress(p => ({ ...p, completed: p.completed + 1 }))
          break
        case 'fatal':
          setFatalError(payload.error)
          break
        case 'cancel_requested':
          setCancelPhase('acknowledged')
          break
      }
    })

    const offDone = window.api.on('preprocess:done', (payload: PreprocessDonePayload) => {
      if (payload.jobId !== jobIdRef.current) return
      setDonePayload(payload)
      setPhase('done')
    })

    return () => {
      offEvent()
      offDone()
    }
  }, [])

  const start = useCallback(async (payload: PreprocessStartPayload) => {
    setStartError(null)
    setFatalError(null)
    setCancelPhase('none')
    setDonePayload(null)
    setProgress(INITIAL_PROGRESS)

    const result = await window.api.invoke('preprocess:start', payload)
    if (!result.ok) {
      setStartError(result.error)
      return
    }
    jobIdRef.current = result.jobId
    setStartedAt(Date.now())
    setPhase('running')
  }, [])

  const cancel = useCallback(async () => {
    if (!jobIdRef.current) return
    // Set synchronously, before the IPC round trip, so the UI reflects the
    // click instantly rather than waiting on the runner's acknowledgement.
    setCancelPhase('requested')
    await window.api.invoke('preprocess:cancel', { jobId: jobIdRef.current })
  }, [])

  const reset = useCallback(() => {
    jobIdRef.current = null
    setPhase('idle')
    setProgress(INITIAL_PROGRESS)
    setStartError(null)
    setFatalError(null)
    setCancelPhase('none')
    setDonePayload(null)
    setStartedAt(null)
  }, [])

  return (
    <PreprocessingJobContext.Provider
      value={{ phase, progress, startError, fatalError, cancelPhase, donePayload, startedAt, start, cancel, reset }}
    >
      {children}
    </PreprocessingJobContext.Provider>
  )
}
