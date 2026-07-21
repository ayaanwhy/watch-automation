// Shared refetch-on-phase-change logic for the two subprocess-job batch-sync
// components (Preprocessing, Ring & Bracelet) — Phase 11C. Stage execution
// status is written directly by the main process (see
// electron/services/subprocessRunner.ts) — the renderer never owns recording
// it. This hook's only job is to refetch the batch whenever a job's phase
// changes in a way that means the registry has (or is about to have) fresher
// data:
//   - 'running': the batch's stage just flipped to running — refetching here
//     is what lets the Configure/Run view switch (Phase 9D) move promptly.
//   - 'done': the stage just reached a terminal status — refetching gives
//     fresh currentStage/nextStage for e.g. the Continue-to-Watch decision.
import { useEffect, useRef } from 'react'
import type { BatchDetailRecord } from '../../types/batch'

export function useJobBatchSync(
  phase: 'idle' | 'running' | 'done',
  batchId: string | null,
  onBatchUpdated: (detail: BatchDetailRecord | null) => void,
): void {
  const prevPhase = useRef(phase)

  useEffect(() => {
    const prev = prevPhase.current
    prevPhase.current = phase
    const justChanged = phase !== prev
    if (justChanged && (phase === 'running' || phase === 'done') && batchId) {
      void window.api.invoke('batch-registry:get', { id: batchId }).then(onBatchUpdated)
    }
  }, [phase, batchId, onBatchUpdated])
}
