import { useEarringJob } from '../../context/EarringJobContext'
import { useJobBatchSync } from './useJobBatchSync'
import type { BatchDetailRecord } from '../../types/batch'

interface EarringBatchSyncProps {
  onBatchUpdated: (detail: BatchDetailRecord | null) => void
}

// Mirrors RingBraceletBatchSync exactly — see that file (and useJobBatchSync,
// Phase 11C) for the shared refetch-on-phase-change logic and why this reads
// job.activeBatchId rather than a caller-supplied batchId prop.
export function EarringBatchSync({ onBatchUpdated }: EarringBatchSyncProps) {
  const job = useEarringJob()
  useJobBatchSync(job.phase, job.activeBatchId, onBatchUpdated)
  return null
}
