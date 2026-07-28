import { createContext, useContext, useEffect, type ReactNode } from 'react'
import type { RingBraceletDonePayload, RingBraceletEventPayload, RingBraceletStartPayload } from '../types/ipc'
import { useSubprocessJob, type BaseImageState, type CancelPhase, type ProgressState } from './useSubprocessJob'

export type RingBraceletPhase = 'idle' | 'running' | 'done'

// Independent from PreprocessingImageStatus (same five values, deliberately
// not imported) — keeps this context decoupled from Preprocessing's, per
// Phase 10's "keep preprocessing and asset generation cleanly separated."
export type RingBraceletImageStatus = BaseImageState['status']

export interface RingBraceletImageState extends BaseImageState {
  frontFullImage: string | null
  frontImage: string | null
  detected: boolean | null
  // Manual QA review flag (Phase 11.5E) — always null for a live run (never
  // set by the runner); populated from the registry only when Batch Details
  // reconstructs this same shape for a historical batch. See
  // types/batch.ts's StageImageRecord.needsFixing for the persisted field.
  needsFixing: boolean | null
}

interface RingBraceletJobContextValue {
  phase: RingBraceletPhase
  progress: ProgressState
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
// rationale, and useSubprocessJob (Phase 11C) for the shared state machine
// both providers build on. runner.py's protocol has no heartbeat/
// initializing-stage concept, so those two progress fields are simply never
// populated here; PreprocessingProgress already renders their absence
// gracefully.
//
// start() intentionally returns Promise<void>, not Promise<boolean> like
// Preprocessing's — Ring & Bracelet has no equivalent of Preprocessing's
// Phase 10F "only navigate to the workspace on a successful start" need.
export function RingBraceletJobProvider({ children }: RingBraceletJobProviderProps) {
  const job = useSubprocessJob<RingBraceletImageState, RingBraceletStartPayload, RingBraceletDonePayload>({
    startInvoke: (payload) => window.api.invoke('ring-bracelet:start', payload),
    cancelInvoke: (jobId) => window.api.invoke('ring-bracelet:cancel', { jobId }),
    buildImage: (name) => ({ name, status: 'pending', frontFullImage: null, frontImage: null, detected: null, needsFixing: null, error: null, durationMs: null }),
    applyEvent: (event, { setImages }) => {
      if (event['type'] === 'complete') {
        const image = event['image'] as string
        setImages(prev =>
          prev.map(img =>
            img.name === image
              ? {
                  ...img,
                  status: 'completed',
                  frontFullImage: (event['frontFullImage'] as string) ?? null,
                  frontImage: (event['frontImage'] as string) ?? null,
                  detected: Boolean(event['detected']),
                  durationMs: (event['duration_ms'] as number) ?? null,
                }
              : img
          )
        )
      }
    },
  })

  useEffect(() => {
    const offEvent = window.api.on('ring-bracelet:event', (payload: RingBraceletEventPayload) => {
      if (payload.jobId !== job.jobIdRef.current) return
      job.dispatchEvent(payload)
    })
    const offDone = window.api.on('ring-bracelet:done', (payload: RingBraceletDonePayload) => {
      if (payload.jobId !== job.jobIdRef.current) return
      job.dispatchDone(payload)
    })
    return () => {
      offEvent()
      offDone()
    }
  }, [job])

  return (
    <RingBraceletJobContext.Provider value={{ ...job, start: async (payload) => { await job.start(payload) } }}>
      {children}
    </RingBraceletJobContext.Provider>
  )
}
