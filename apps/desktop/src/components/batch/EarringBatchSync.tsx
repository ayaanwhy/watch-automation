import { useEarringJob } from '../../context/EarringJobContext'
import { useJobBatchSync } from './useJobBatchSync'
import type { BatchDetailRecord } from '../../types/batch'

interface EarringBatchSyncProps {
  batchId: string | null
  onBatchUpdated: (detail: BatchDetailRecord | null) => void
}

// Mirrors RingBraceletBatchSync exactly — see useJobBatchSync (Phase 11C)
// for the shared refetch-on-phase-change logic.
export function EarringBatchSync({ batchId, onBatchUpdated }: EarringBatchSyncProps) {
  const job = useEarringJob()
  useJobBatchSync(job.phase, batchId, onBatchUpdated)
  return null
}
