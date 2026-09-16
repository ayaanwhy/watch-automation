import type { EarringDonePayload, EarringStartPayload } from '../types/ipc'
import { type BaseImageState, type CancelPhase, type ProgressState } from './useSubprocessJob'
import { createJobContext } from './createJobContext'

export type EarringPhase = 'idle' | 'running' | 'done'

export type EarringImageStatus = BaseImageState['status']

// Deliberately shaped identically to RingBraceletImageState (same field
// names, not just same field count) — this lets RingBraceletImagePreviewPanel
// render Earring images too, with zero new preview component. For Stud/Drop,
// whose complete events never carry a real frontFullImage, this slot is
// populated from 'compare' instead (mirroring the same compare→frontFullImage
// fallback BatchDetails.tsx uses for the persisted/historical view) — for
// Hoop (Phase 12D), whose events carry a genuine frontFullImage (an
// unmodified duplicate of compare, per the Architectural Rules), that real
// value is used directly, which is equivalent content either way. detected
// stays null for Stud/Drop (no masking/confidence step); Hoop populates it
// from hoop_mask.py's (mask, detected) contract, same low-confidence
// semantics as Ring & Bracelet's own detected flag.
export interface EarringImageState extends BaseImageState {
  frontFullImage: string | null
  frontImage: string | null
  detected: boolean | null
  needsFixing: boolean | null
}

interface EarringJobContextValue {
  phase: EarringPhase
  progress: ProgressState
  images: EarringImageState[]
  startError: string | null
  fatalError: string | null
  cancelPhase: CancelPhase
  donePayload: EarringDonePayload | null
  startedAt: number | null
  activeBatchId: string | null
  start(payload: EarringStartPayload): Promise<void>
  cancel(): Promise<void>
  reset(): void
  // Queueing (Item 5A, post-Phase-13 polish) — see useSubprocessJob's own
  // doc comments on these three for the full contract.
  enqueue(payload: EarringStartPayload): void
  queuedBatchIds: string[]
  cancelQueued(batchId: string): void
}

// Mirrors RingBraceletJobContext's structure exactly — see that file and
// PreprocessingJobContext for the fuller rationale (app-lifetime provider,
// useSubprocessJob for the state machine, createJobContext for the shared
// context/provider/subscription wiring). start() returns Promise<void> for
// the same reason Ring & Bracelet's does: no "only navigate on success" need.
const earringJob = createJobContext<EarringImageState, EarringStartPayload, EarringDonePayload, EarringJobContextValue>({
  hookErrorMessage: 'useEarringJob must be used within EarringJobProvider',
  eventChannel: 'earring:event',
  doneChannel: 'earring:done',
  jobConfig: {
    startInvoke: (payload) => window.api.invoke('earring:start', payload),
    cancelInvoke: (jobId) => window.api.invoke('earring:cancel', { jobId }),
    buildImage: (name) => ({ name, status: 'pending', frontFullImage: null, frontImage: null, detected: null, needsFixing: null, error: null, durationMs: null }),
    applyEvent: (event, { setImages }) => {
      if (event['type'] === 'complete') {
        const image = event['image'] as string
        const detected = event['detected']
        setImages(prev =>
          prev.map(img =>
            img.name === image
              ? {
                  ...img,
                  status: 'completed',
                  frontFullImage: (event['frontFullImage'] as string) ?? (event['compare'] as string) ?? null,
                  frontImage: (event['frontImage'] as string) ?? null,
                  detected: typeof detected === 'boolean' ? detected : null,
                  durationMs: (event['duration_ms'] as number) ?? null,
                }
              : img
          )
        )
      }
    },
  },
  buildValue: (job) => ({ ...job, start: async (payload) => { await job.start(payload) } }),
})

export const useEarringJob = earringJob.useJob
export const EarringJobProvider = earringJob.Provider
