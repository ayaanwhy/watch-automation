import { useRingBraceletJob } from '../../context/RingBraceletJobContext'
import { useJobBatchSync } from './useJobBatchSync'
import type { BatchDetailRecord } from '../../types/batch'

interface RingBraceletBatchSyncProps {
  batchId: string | null
  onBatchUpdated: (detail: BatchDetailRecord | null) => void
}

// Mirrors PreprocessingBatchSync exactly — see useJobBatchSync (Phase 11C)
// for the shared refetch-on-phase-change logic. Stage status here is written
// by subprocessRunner.ts's 'editing'-stage config, not the renderer.
export function RingBraceletBatchSync({ batchId, onBatchUpdated }: RingBraceletBatchSyncProps) {
  const job = useRingBraceletJob()
  useJobBatchSync(job.phase, batchId, onBatchUpdated)
  return null
}
