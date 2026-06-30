import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreprocessDonePayload, PreprocessEventPayload, PreprocessStartPayload } from '../types/ipc'

export type PreprocessingPhase = 'idle' | 'running' | 'done'

export interface PreprocessingProgressState {
  total: number
  completed: number
  currentImage: string | null
  currentStage: string | null
  lastHeartbeatAt: number | null
}

const INITIAL_PROGRESS: PreprocessingProgressState = {
  total: 0,
  completed: 0,
  currentImage: null,
  currentStage: null,
  lastHeartbeatAt: null,
}

// Centralizes all preprocess:* IPC wiring for one job's lifecycle: start,
// cancel, live NDJSON-derived progress, and the terminal completion payload.
export function usePreprocessingJob() {
  const [phase, setPhase] = useState<PreprocessingPhase>('idle')
  const [progress, setProgress] = useState<PreprocessingProgressState>(INITIAL_PROGRESS)
  const [startError, setStartError] = useState<string | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [donePayload, setDonePayload] = useState<PreprocessDonePayload | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)

  // Refs so the long-lived event subscription below can read the current
  // job id without needing to resubscribe on every start().
  const jobIdRef = useRef<string | null>(null)

  useEffect(() => {
    // Subscribe before any job can start, per the established pattern of
    // never missing the first notification.
    const offEvent = window.api.on('preprocess:event', (payload: PreprocessEventPayload) => {
      if (payload.jobId !== jobIdRef.current) return

      switch (payload.type) {
        case 'start':
          setProgress(p => ({ ...p, total: payload.total }))
          break
        case 'progress':
          setProgress(p => ({ ...p, currentImage: payload.image, currentStage: payload.stage }))
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
          setCancelRequested(true)
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
    setCancelRequested(false)
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
    await window.api.invoke('preprocess:cancel', { jobId: jobIdRef.current })
  }, [])

  const reset = useCallback(() => {
    jobIdRef.current = null
    setPhase('idle')
    setProgress(INITIAL_PROGRESS)
    setStartError(null)
    setFatalError(null)
    setCancelRequested(false)
    setDonePayload(null)
    setStartedAt(null)
  }, [])

  return {
    phase,
    progress,
    startError,
    fatalError,
    cancelRequested,
    donePayload,
    startedAt,
    start,
    cancel,
    reset,
  }
}
