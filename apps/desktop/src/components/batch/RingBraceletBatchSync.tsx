import { useRingBraceletJob } from '../../context/RingBraceletJobContext'
import { useJobBatchSync } from './useJobBatchSync'
import type { BatchDetailRecord } from '../../types/batch'

interface RingBraceletBatchSyncProps {
  onBatchUpdated: (detail: BatchDetailRecord | null) => void
}

// Mirrors PreprocessingBatchSync exactly — see that file (and useJobBatchSync,
// Phase 11C) for the shared refetch-on-phase-change logic and why this reads
// job.activeBatchId rather than a caller-supplied batchId prop. Stage status
// here is written by subprocessRunner.ts's 'editing'-stage config, not the
// renderer.
export function RingBraceletBatchSync({ onBatchUpdated }: RingBraceletBatchSyncProps) {
  const job = useRingBraceletJob()
  useJobBatchSync(job.phase, job.activeBatchId, onBatchUpdated)
  return null
}
