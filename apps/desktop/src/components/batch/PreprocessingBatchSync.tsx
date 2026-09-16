import { usePreprocessingJob } from '../../context/PreprocessingJobContext'
import { useJobBatchSync } from './useJobBatchSync'
import type { BatchDetailRecord } from '../../types/batch'

interface PreprocessingBatchSyncProps {
  onBatchUpdated: (detail: BatchDetailRecord | null) => void
}

// Always mounted alongside PreprocessingJobProvider, independent of which
// screen is currently visible, so a job that finishes while the user has
// navigated away still gets its batch refreshed. See useJobBatchSync
// (Phase 11C) for the shared refetch-on-phase-change logic.
//
// Reads job.activeBatchId (Item 5A, post-Phase-13 polish) rather than a
// batchId prop the caller sets once at Start — a queued batch that later
// auto-starts has no such caller-side moment, so the hook's own record of
// which batch its current job belongs to is the only thing that stays
// correct across a drain.
export function PreprocessingBatchSync({ onBatchUpdated }: PreprocessingBatchSyncProps) {
  const job = usePreprocessingJob()
  useJobBatchSync(job.phase, job.activeBatchId, onBatchUpdated)
  return null
}
