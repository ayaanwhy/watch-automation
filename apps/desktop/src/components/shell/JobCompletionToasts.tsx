import { useEffect, useRef } from 'react'
import { usePreprocessingJob } from '../../context/PreprocessingJobContext'
import { useRingBraceletJob } from '../../context/RingBraceletJobContext'
import { useEarringJob } from '../../context/EarringJobContext'
import { useToast } from '../ui/ToastHost'
import type { BatchDetailRecord } from '../../types/batch'

interface JobCompletionToastsProps {
  preprocessBatch: BatchDetailRecord | null
  editingBatch: BatchDetailRecord | null
  onOpenBatch: (id: string) => void
}

interface DonePayloadLike {
  succeeded: number
  failed: number
  cancelledByUser: boolean
}

// Fires a toast on each job's running → done transition (Phase 13C —
// Navigation spec: "Toasts... batch completion... and failures, since jobs
// already outlive navigation"). Purely a read of the three existing job
// contexts' phase/donePayload; no job logic, no IPC. Mounted once inside
// the providers (see App.tsx), alongside Sidebar. The optional native
// macOS notification the spec also mentions is deferred — it needs new
// main-process IPC (Electron's Notification API), which is more than this
// shell/ambient pass's scope; the plan itself calls it "optional."
export function JobCompletionToasts({ preprocessBatch, editingBatch, onOpenBatch }: JobCompletionToastsProps) {
  const { showToast } = useToast()
  const preprocessingJob = usePreprocessingJob()
  const ringBraceletJob = useRingBraceletJob()
  const earringJob = useEarringJob()

  useJobCompletionToast(preprocessingJob.phase, preprocessingJob.donePayload, preprocessBatch, showToast, onOpenBatch)
  useJobCompletionToast(ringBraceletJob.phase, ringBraceletJob.donePayload, editingBatch, showToast, onOpenBatch)
  useJobCompletionToast(earringJob.phase, earringJob.donePayload, editingBatch, showToast, onOpenBatch)

  return null
}

function useJobCompletionToast(
  phase: 'idle' | 'running' | 'done',
  donePayload: DonePayloadLike | null,
  batch: BatchDetailRecord | null,
  showToast: ReturnType<typeof useToast>['showToast'],
  onOpenBatch: (id: string) => void,
) {
  const prevPhase = useRef(phase)

  useEffect(() => {
    if (prevPhase.current === 'running' && phase === 'done' && donePayload) {
      const title = batch?.title ?? 'Batch'
      const batchId = batch?.id

      if (donePayload.cancelledByUser) {
        showToast({
          tone: 'default',
          title: `${title} cancelled`,
          description: `${donePayload.succeeded} completed before cancelling.`,
          onAction: batchId ? () => onOpenBatch(batchId) : undefined,
          actionLabel: batchId ? 'View' : undefined,
        })
      } else if (donePayload.failed > 0) {
        showToast({
          tone: 'danger',
          title: `${title} — ${donePayload.failed} failed`,
          description: `${donePayload.succeeded} succeeded.`,
          onAction: batchId ? () => onOpenBatch(batchId) : undefined,
          actionLabel: batchId ? 'View' : undefined,
        })
      } else {
        showToast({
          tone: 'success',
          title: `${title} completed`,
          description: `${donePayload.succeeded} succeeded.`,
          onAction: batchId ? () => onOpenBatch(batchId) : undefined,
          actionLabel: batchId ? 'View' : undefined,
        })
      }
    }
    prevPhase.current = phase
  }, [phase, donePayload, batch, showToast, onOpenBatch])
}
