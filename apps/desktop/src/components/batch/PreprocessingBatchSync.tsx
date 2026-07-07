import { useEffect, useRef } from 'react'
import { usePreprocessingJob } from '../../context/PreprocessingJobContext'
import type { BatchDetailRecord } from '../../types/batch'

interface PreprocessingBatchSyncProps {
  batchId: string | null
  onBatchUpdated: (detail: BatchDetailRecord | null) => void
}

// Stage execution status is written directly by the main process (see
// electron/ipc/preprocessHandlers.ts) — the renderer no longer owns
// recording it. This component's only job is to refetch the batch whenever
// the job's phase changes in a way that means the registry has (or is about
// to have) fresher data:
//   - 'running': the batch's preprocessing stage just flipped to running —
//     refetching here is what lets Preprocessing.tsx's Batch-status-driven
//     view switch (Phase 9D) move from Configure to Run promptly.
//   - 'done': the stage just reached a terminal status — refetching gives
//     fresh currentStage/nextStage for the Continue-to-Watch decision, and
//     flips the view switch from Run to Batch Details.
//
// Always mounted alongside PreprocessingJobProvider, independent of which
// screen is currently visible, so a job that finishes while the user has
// navigated away still gets its batch refreshed.
export function PreprocessingBatchSync({ batchId, onBatchUpdated }: PreprocessingBatchSyncProps) {
  const job = usePreprocessingJob()
  const prevPhase = useRef(job.phase)

  useEffect(() => {
    const prev = prevPhase.current
    prevPhase.current = job.phase
    const justChanged = job.phase !== prev
    if (justChanged && (job.phase === 'running' || job.phase === 'done') && batchId) {
      void window.api.invoke('batch-registry:get', { id: batchId }).then(onBatchUpdated)
    }
  }, [job.phase, batchId, onBatchUpdated])

  return null
}
