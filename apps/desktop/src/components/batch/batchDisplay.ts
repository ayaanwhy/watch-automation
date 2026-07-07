import type { BatchDetailRecord, BatchStatus, StageStatus, StageType } from '../../types/batch'
import type { ChipTone } from '../ui/StatusChip'

// Shared display mappings for the Batch-first UI (Home cards, contextual
// sidebar, batch workspace). Kept pure so it can be reused anywhere.

export const STAGE_LABELS: Record<StageType, string> = {
  preprocessing: 'Preprocessing',
  watch: 'Watch Processing',
  qa: 'QA',
  export: 'Export',
}

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  draft: 'Draft',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function batchStatusTone(status: BatchStatus): ChipTone {
  switch (status) {
    case 'completed': return 'ok'
    case 'failed': return 'err'
    case 'cancelled': return 'warn'
    case 'in_progress': return 'running'
    default: return 'neutral'
  }
}

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  not_started: 'Not started',
  configuring: 'Configuring',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function stageStatusTone(status: StageStatus): ChipTone {
  switch (status) {
    case 'completed': return 'ok'
    case 'failed': return 'err'
    case 'cancelled': return 'warn'
    case 'running': return 'running'
    default: return 'neutral'
  }
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// Reads a specific stage's status off a batch — the single source of truth
// a stage screen (e.g. Preprocessing) uses to decide which of its
// Configure/Run/Batch-Details experiences to show. 'none' means the batch
// doesn't exist yet (or has no such stage), which routes to Configure.
export function findStageStatus(batch: BatchDetailRecord | null, type: StageType): StageStatus | 'none' {
  if (!batch) return 'none'
  return batch.stages.find(s => s.type === type)?.status ?? 'none'
}

export function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diffMin = Math.floor((Date.now() - then) / 60000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const hr = Math.floor(diffMin / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(then).toLocaleDateString()
}
