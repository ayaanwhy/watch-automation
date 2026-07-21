import { usePreprocessingJob } from '../../context/PreprocessingJobContext'
import { useJobBatchSync } from './useJobBatchSync'
import type { BatchDetailRecord } from '../../types/batch'

interface PreprocessingBatchSyncProps {
  batchId: string | null
  onBatchUpdated: (detail: BatchDetailRecord | null) => void
}

// Always mounted alongside PreprocessingJobProvider, independent of which
// screen is currently visible, so a job that finishes while the user has
// navigated away still gets its batch refreshed. See useJobBatchSync
// (Phase 11C) for the shared refetch-on-phase-change logic.
export function PreprocessingBatchSync({ batchId, onBatchUpdated }: PreprocessingBatchSyncProps) {
  const job = usePreprocessingJob()
  useJobBatchSync(job.phase, batchId, onBatchUpdated)
  return null
}
