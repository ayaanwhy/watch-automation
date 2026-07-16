import { useEffect, useRef } from 'react'
import { useRingBraceletJob } from '../../context/RingBraceletJobContext'
import type { BatchDetailRecord } from '../../types/batch'

interface RingBraceletBatchSyncProps {
  batchId: string | null
  onBatchUpdated: (detail: BatchDetailRecord | null) => void
}

// Mirrors PreprocessingBatchSync exactly — refetches the batch whenever the
// job's phase changes in a way that means the registry has (or is about to
// have) fresher data. See that component for the fuller rationale; stage
// status here is written by ringBraceletHandlers.ts, not the renderer.
export function RingBraceletBatchSync({ batchId, onBatchUpdated }: RingBraceletBatchSyncProps) {
  const job = useRingBraceletJob()
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
