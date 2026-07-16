import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RingBraceletDonePayload, RingBraceletEventPayload, RingBraceletStartPayload } from '../types/ipc'
import type { CancelPhase, PreprocessingProgressState } from './PreprocessingJobContext'

export type RingBraceletPhase = 'idle' | 'running' | 'done'

// Independent from PreprocessingImageStatus (same five values, deliberately
// not imported) — keeps this context decoupled from Preprocessing's, per
// Phase 10's "keep preprocessing and asset generation cleanly separated."
export type RingBraceletImageStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'

export interface RingBraceletImageState {
  name: string
  status: RingBraceletImageStatus
  frontFullImage: string | null
  frontImage: string | null
  detected: boolean | null
  error: string | null
  durationMs: number | null
}

const INITIAL_PROGRESS: PreprocessingProgressState = {
  total: 0,
  completed: 0,
  currentImage: null,
  currentStage: null,
  lastHeartbeatAt: null,
  initializingStage: null,
}

interface RingBraceletJobContextValue {
  phase: RingBraceletPhase
  progress: PreprocessingProgressState
  images: RingBraceletImageState[]
  startError: string | null
  fatalError: string | null
  cancelPhase: CancelPhase
  donePayload: RingBraceletDonePayload | null
  startedAt: number | null
  start(payload: RingBraceletStartPayload): Promise<void>
  cancel(): Promise<void>
  reset(): void
}

const RingBraceletJobContext = createContext<RingBraceletJobContextValue | null>(null)

export function useRingBraceletJob(): RingBraceletJobContextValue {
  const ctx = useContext(RingBraceletJobContext)
  if (!ctx) throw new Error('useRingBraceletJob must be used within RingBraceletJobProvider')
  return ctx
}

interface RingBraceletJobProviderProps {
  children: ReactNode
}

// Mirrors PreprocessingJobProvider's structure exactly (mounted for the
// lifetime of the app, not the lifetime of whichever screen is visible, so
// an in-progress job survives navigation) — see that file for the fuller
// rationale. runner.py's protocol has no heartbeat/initializing-stage
// concept, so those two progress fields are simply never populated here;
// PreprocessingProgress already renders their absence gracefully.
export function RingBraceletJobProvider({ children }: RingBraceletJobProviderProps) {
  const [phase, setPhase] = useState<RingBraceletPhase>('idle')
  const [progress, setProgress] = useState<PreprocessingProgressState>(INITIAL_PROGRESS)
  const [images, setImages] = useState<RingBraceletImageState[]>([])
  const [startError, setStartError] = useState<string | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [cancelPhase, setCancelPhase] = useState<CancelPhase>('none')
  const [donePayload, setDonePayload] = useState<RingBraceletDonePayload | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)

  const jobIdRef = useRef<string | null>(null)

  useEffect(() => {
    const offEvent = window.api.on('ring-bracelet:event', (payload: RingBraceletEventPayload) => {
      if (payload.jobId !== jobIdRef.current) return

      switch (payload.type) {
        case 'start':
          setProgress(p => ({ ...p, total: payload.total }))
          setImages(
            payload.images.map(name => ({
              name,
              status: 'pending',
              frontFullImage: null,
              frontImage: null,
              detected: null,
              error: null,
              durationMs: null,
            }))
          )
          break
        case 'progress':
          setProgress(p => ({ ...p, currentImage: payload.image, currentStage: payload.stage }))
          setImages(prev =>
            prev.map(img =>
              img.name === payload.image
                ? { ...img, status: img.status === 'pending' ? 'processing' : img.status }
                : img
            )
          )
          break
        case 'complete':
          setProgress(p => ({ ...p, completed: p.completed + 1 }))
          setImages(prev =>
            prev.map(img =>
              img.name === payload.image
                ? {
                    ...img,
                    status: 'completed',
                    frontFullImage: payload.frontFullImage,
                    frontImage: payload.frontImage,
                    detected: payload.detected,
                    durationMs: payload.duration_ms,
                  }
                : img
            )
          )
          break
        case 'error':
          setProgress(p => ({ ...p, completed: p.completed + 1 }))
          setImages(prev =>
            prev.map(img =>
              img.name === payload.image ? { ...img, status: 'failed', error: payload.error } : img
            )
          )
          break
        case 'fatal':
          setFatalError(payload.error)
          break
        case 'cancel_requested':
          setCancelPhase('acknowledged')
          break
      }
    })

    const offDone = window.api.on('ring-bracelet:done', (payload: RingBraceletDonePayload) => {
      if (payload.jobId !== jobIdRef.current) return
      setDonePayload(payload)
      setPhase('done')
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
    })

    return () => {
      offEvent()
      offDone()
    }
  }, [])

  const start = useCallback(async (payload: RingBraceletStartPayload) => {
    setStartError(null)
    setFatalError(null)
    setCancelPhase('none')
    setDonePayload(null)
    setProgress(INITIAL_PROGRESS)
    setImages([])

    const result = await window.api.invoke('ring-bracelet:start', payload)
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
    setCancelPhase('requested')
    await window.api.invoke('ring-bracelet:cancel', { jobId: jobIdRef.current })
  }, [])

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
  }, [])

  return (
    <RingBraceletJobContext.Provider
      value={{ phase, progress, images, startError, fatalError, cancelPhase, donePayload, startedAt, start, cancel, reset }}
    >
      {children}
    </RingBraceletJobContext.Provider>
  )
}
