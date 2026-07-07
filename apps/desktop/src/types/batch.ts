// Batch-first workflow model (Phase 9B).
//
// A Batch is the primary entity — one execution-history item over a set of
// images. It owns an ordered `pipeline` of Stages (Preprocessing, Watch
// Processing, and — future — QA, Export). Each Stage carries its own status,
// config, and I/O while belonging to the same Batch.
//
// `pipeline` is the source of truth for stage order; `currentStage`/`nextStage`
// are cached pointers derived from it (see electron/services/batchModel.ts), so
// future non-linear pipelines and automation don't assume a fixed workflow.
//
// Concurrency note: nothing here caps how many batches/stages may be `running`
// at once. "One stage at a time" is an execution *policy* (the scheduler),
// not a schema invariant — Phase 10 can add queues without touching this model.

export const BATCH_REGISTRY_VERSION = 1

export type StageType = 'preprocessing' | 'watch' | 'qa' | 'export'

export type StageStatus =
  | 'not_started'
  | 'configuring'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type BatchStatus =
  | 'draft'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface StageCounts {
  total: number
  succeeded: number
  failed: number
  cancelled: number
}

export interface StageRef {
  // Watch stage → its underlying annotation SessionFile (kept as an internal
  // detail of the stage; the Batch is the authoritative entry point).
  sessionKey?: string
}

export interface StageRecord {
  type: StageType
  status: StageStatus
  inputDir: string
  outputDir: string | null
  config: Record<string, unknown>
  counts: StageCounts
  ref: StageRef
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
}

// Partial update applied to a single stage via the registry.
export interface StagePatch {
  status?: StageStatus
  inputDir?: string
  outputDir?: string | null
  config?: Record<string, unknown>
  counts?: StageCounts
  ref?: StageRef
  error?: string | null
}

// Lightweight index entry — everything a Home card needs at a glance without
// loading the full detail file.
export interface BatchSummaryRecord {
  id: string
  seq: number
  title: string
  status: BatchStatus
  sourceDir: string
  pipeline: StageType[]
  stageStatuses: { type: StageType; status: StageStatus }[]
  currentStage: StageType | null
  nextStage: StageType | null
  counts: StageCounts
  durationMs: number | null
  createdAt: string
  updatedAt: string
}

// Full persisted record (index summary + per-stage detail).
export interface BatchDetailRecord extends BatchSummaryRecord {
  stages: StageRecord[]
}

// Entry choices offered at batch creation, mapped to a starting pipeline.
// QA/Export are intentionally absent until those stages exist.
export type BatchEntry = 'full' | 'preprocessing' | 'watch'

export const PIPELINE_TEMPLATES: Record<BatchEntry, StageType[]> = {
  full: ['preprocessing', 'watch'],
  preprocessing: ['preprocessing'],
  watch: ['watch'],
}
