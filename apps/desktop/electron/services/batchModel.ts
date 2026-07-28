// Pure batch/stage derivation logic — NO electron or fs imports, so it is
// unit-testable from the repo-root vitest suite. batchRegistry.ts owns all
// persistence and delegates every state computation here.

import type {
  BatchDetailRecord,
  BatchMode,
  BatchStatus,
  BatchSummaryRecord,
  StageCounts,
  StagePatch,
  StageRecord,
  StageType,
} from '../../src/types/batch'

export const ZERO_COUNTS: StageCounts = { total: 0, succeeded: 0, failed: 0, cancelled: 0, needsFixing: 0 }

const TERMINAL: StageRecord['status'][] = ['completed', 'failed', 'cancelled']

export function formatBatchTitle(seq: number, mode: BatchMode = 'production'): string {
  const padded = String(seq).padStart(3, '0')
  return mode === 'testing' ? `Test Batch ${padded}` : `Batch ${padded}`
}

export function emptyStage(type: StageType, inputDir: string, now: string): StageRecord {
  return {
    type,
    status: 'not_started',
    inputDir,
    outputDir: null,
    config: {},
    counts: { ...ZERO_COUNTS },
    images: [],
    ref: {},
    createdAt: now,
    startedAt: null,
    completedAt: null,
    error: null,
  }
}

// currentStage: the stage the user/engine is (or should be) acting on.
// A running stage always wins; otherwise the first stage in pipeline order that
// is not yet completed. Returns null when every stage is completed.
export function computeCurrentStage(pipeline: StageType[], stages: StageRecord[]): StageType | null {
  const byType = new Map(stages.map(s => [s.type, s]))
  const running = pipeline.find(t => byType.get(t)?.status === 'running')
  if (running) return running
  const firstIncomplete = pipeline.find(t => {
    const s = byType.get(t)
    return s !== undefined && s.status !== 'completed'
  })
  return firstIncomplete ?? null
}

// nextStage: the successor of currentStage in pipeline order (null at the end).
export function computeNextStage(pipeline: StageType[], current: StageType | null): StageType | null {
  if (current === null) return null
  const idx = pipeline.indexOf(current)
  if (idx < 0 || idx + 1 >= pipeline.length) return null
  return pipeline[idx + 1]
}

export function deriveBatchStatus(stages: StageRecord[]): BatchStatus {
  if (stages.length === 0) return 'draft'
  const statuses = stages.map(s => s.status)
  if (statuses.some(s => s === 'running')) return 'in_progress'
  if (statuses.every(s => s === 'completed')) return 'completed'
  if (statuses.some(s => s === 'failed')) return 'failed'
  if (statuses.some(s => s === 'cancelled')) return 'cancelled'
  if (statuses.some(s => s !== 'not_started')) return 'in_progress'
  return 'draft'
}

// The batch's headline counts follow its current stage (fallback: the last
// stage), so a Home card reflects whatever stage is in focus.
export function rollupCounts(stages: StageRecord[], current: StageType | null): StageCounts {
  const byType = new Map(stages.map(s => [s.type, s]))
  const stage = current ? byType.get(current) : undefined
  if (stage) return { ...stage.counts }
  const last = stages[stages.length - 1]
  return last ? { ...last.counts } : { ...ZERO_COUNTS }
}

// A duration is available once at least one stage has both started and
// finished; spans earliest start → latest finish. Live in-progress timing is
// left to the UI.
export function computeDurationMs(stages: StageRecord[]): number | null {
  const starts = stages.filter(s => s.startedAt).map(s => Date.parse(s.startedAt as string))
  const ends = stages.filter(s => s.completedAt).map(s => Date.parse(s.completedAt as string))
  if (starts.length === 0 || ends.length === 0) return null
  return Math.max(0, Math.max(...ends) - Math.min(...starts))
}

// Recomputes every derived field from `stages` + `pipeline`. The single place
// currentStage/nextStage/status/counts/duration/stageStatuses are maintained.
export function recompute(detail: BatchDetailRecord, now: string): BatchDetailRecord {
  const current = computeCurrentStage(detail.pipeline, detail.stages)
  return {
    ...detail,
    stageStatuses: detail.stages.map(s => ({ type: s.type, status: s.status })),
    currentStage: current,
    nextStage: computeNextStage(detail.pipeline, current),
    status: deriveBatchStatus(detail.stages),
    counts: rollupCounts(detail.stages, current),
    durationMs: computeDurationMs(detail.stages),
    updatedAt: now,
  }
}

export function createBatchDetail(params: {
  id: string
  seq: number
  sourceDir: string
  pipeline: StageType[]
  title?: string
  mode?: BatchMode
  now: string
}): BatchDetailRecord {
  const { id, seq, sourceDir, pipeline, title, mode, now } = params
  const stages = pipeline.map((type, i) => emptyStage(type, i === 0 ? sourceDir : '', now))
  const base: BatchDetailRecord = {
    id,
    seq,
    title: title?.trim() || formatBatchTitle(seq, mode),
    status: 'draft',
    mode,
    sourceDir,
    pipeline,
    stageStatuses: [],
    currentStage: null,
    nextStage: null,
    counts: { ...ZERO_COUNTS },
    durationMs: null,
    createdAt: now,
    updatedAt: now,
    stages,
  }
  return recompute(base, now)
}

export function applyStagePatch(
  detail: BatchDetailRecord,
  stageType: StageType,
  patch: StagePatch,
  now: string,
): BatchDetailRecord {
  const stages = detail.stages.map(s => {
    if (s.type !== stageType) return s
    const next: StageRecord = {
      ...s,
      ...patch,
      config: patch.config ? { ...s.config, ...patch.config } : s.config,
      ref: patch.ref ? { ...s.ref, ...patch.ref } : s.ref,
    }
    // Stamp lifecycle timestamps on status transitions.
    if (patch.status === 'running' && s.startedAt === null) next.startedAt = now
    if (patch.status && TERMINAL.includes(patch.status)) next.completedAt = now
    return next
  })
  return recompute({ ...detail, stages }, now)
}

// Strips per-stage detail to produce the lightweight index entry.
export function summarize(detail: BatchDetailRecord): BatchSummaryRecord {
  const { stages: _stages, ...summary } = detail
  return summary
}
