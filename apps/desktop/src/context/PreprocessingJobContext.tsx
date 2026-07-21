import { createContext, useContext, useEffect, type ReactNode } from 'react'
import type { PreprocessDonePayload, PreprocessEventPayload, PreprocessStartPayload } from '../types/ipc'
import {
  useSubprocessJob,
  type BaseImageState,
  type CancelPhase,
  type ProgressState,
} from './useSubprocessJob'

export type PreprocessingPhase = 'idle' | 'running' | 'done'
export type { CancelPhase, ProgressState as PreprocessingProgressState }

// Per-image status (Phase 9D) — feeds the execution workspace's thumbnail
// grid. Built entirely from the existing NDJSON event stream; no Python or
// wire-protocol changes were needed, since 'start' already lists every image
// and 'progress'/'complete'/'error' already report per-image outcomes.
export type PreprocessingImageStatus = BaseImageState['status']

export interface PreprocessingImageState extends BaseImageState {
  stage: string | null
  outputPath: string | null
}

interface PreprocessingJobContextValue {
  phase: PreprocessingPhase
  progress: ProgressState
  images: PreprocessingImageState[]
  startError: string | null
  fatalError: string | null
  cancelPhase: CancelPhase
  donePayload: PreprocessDonePayload | null
  startedAt: number | null
  // Resolves true only once the job has actually started (jobId assigned,
  // phase → 'running') — the caller (Preprocessing.tsx, Phase 10F) uses this
  // to decide whether to navigate to the dedicated workspace screen, rather
  // than navigating unconditionally and leaving a failed start stranded
  // there with no retry-friendly Configure form in view.
  start(payload: PreprocessStartPayload): Promise<boolean>
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
// lifetime of whichever screen happens to be mounted. Mounting this provider
// above the conditionally-rendered content (in App.tsx) lets an in-progress
// job's state and IPC subscription survive navigating away and back.
//
// Shared state machine lives in useSubprocessJob (Phase 11C) — this provider
// supplies only what's genuinely Preprocessing-specific: the image shape,
// the IPC channels, and how 'complete' (plus the pipeline-only 'progress'
// per-image stage / 'initializing' / 'heartbeat' events) update that shape.
export function PreprocessingJobProvider({ children }: PreprocessingJobProviderProps) {
  const job = useSubprocessJob<PreprocessingImageState, PreprocessStartPayload, PreprocessDonePayload>({
    startInvoke: (payload) => window.api.invoke('preprocess:start', payload),
    cancelInvoke: (jobId) => window.api.invoke('preprocess:cancel', { jobId }),
    buildImage: (name) => ({ name, status: 'pending', stage: null, outputPath: null, error: null, durationMs: null }),
    applyEvent: (event, { setProgress, setImages }) => {
      switch (event['type']) {
        case 'initializing':
          setProgress(p => ({ ...p, initializingStage: event['stage'] as string }))
          break
        case 'heartbeat':
          setProgress(p => ({ ...p, lastHeartbeatAt: Date.now() }))
          break
        case 'progress': {
          const image = event['image'] as string
          setImages(prev => prev.map(img => (img.name === image ? { ...img, stage: (event['stage'] as string) ?? null } : img)))
          break
        }
        case 'complete': {
          const image = event['image'] as string
          setImages(prev =>
            prev.map(img =>
              img.name === image
                ? { ...img, status: 'completed', stage: null, outputPath: (event['output'] as string) ?? null, durationMs: (event['duration_ms'] as number) ?? null }
                : img
            )
          )
          break
        }
      }
    },
  })

  useEffect(() => {
    // Subscribe before any job can start, per the established pattern of
    // never missing the first notification.
    const offEvent = window.api.on('preprocess:event', (payload: PreprocessEventPayload) => {
      if (payload.jobId !== job.jobIdRef.current) return
      job.dispatchEvent(payload)
    })
    const offDone = window.api.on('preprocess:done', (payload: PreprocessDonePayload) => {
      if (payload.jobId !== job.jobIdRef.current) return
      job.dispatchDone(payload)
    })
    return () => {
      offEvent()
      offDone()
    }
  }, [job])

  return (
    <PreprocessingJobContext.Provider value={job}>
      {children}
    </PreprocessingJobContext.Provider>
  )
}
