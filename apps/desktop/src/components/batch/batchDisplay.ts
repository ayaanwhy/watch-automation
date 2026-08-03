import type { BatchDetailRecord, BatchStatus, StageStatus, StageType } from '../../types/batch'
import type { BadgeTone } from '../ui/Badge'

// Shared display mappings for the Batch-first UI (Home cards, contextual
// sidebar, batch workspace). Kept pure so it can be reused anywhere.

export const STAGE_LABELS: Record<StageType, string> = {
  preprocessing: 'Preprocessing',
  watch: 'Watch Processing',
  editing: 'Editing',
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

// Phase 13D — returns Badge's tone vocabulary (StatusChip retired; both of
// this function's only two consumers, BatchCard and BatchDetails, migrated
// to Badge in this same phase).
export function batchStatusTone(status: BatchStatus): BadgeTone {
  switch (status) {
    case 'completed': return 'success'
    case 'failed': return 'danger'
    case 'cancelled': return 'warning'
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

export function stageStatusTone(status: StageStatus): BadgeTone {
  switch (status) {
    case 'completed': return 'success'
    case 'failed': return 'danger'
    case 'cancelled': return 'warning'
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

// Reads one key out of a stage's free-form config for display, formatting
// booleans as On/Off. Shared by every stage type's "configuration used"
// block in Batch Details (Phase 9E) rather than each reimplementing it.
export function readConfigValue(config: Record<string, unknown>, key: string): string | null {
  const value = config[key]
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  return String(value)
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
