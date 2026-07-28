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

// 'editing' is the general product-specific asset-generation stage category
// (Phase 10C: Ring & Bracelet today, via config.product; future products —
// e.g. Earring — reuse this same type with a different config.product rather
// than minting a new StageType each time, mirroring how 'preprocessing'
// already covers multiple products via config.objectType). 'watch' predates
// this generalization and remains its own separate type — folding it into
// 'editing' is an Architecture Strengthening question, not addressed here.
export type StageType = 'preprocessing' | 'watch' | 'editing' | 'qa' | 'export'

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

// Testing vs Production (Phase 10F) — independent numbering/title prefix per
// mode (see batchModel.formatBatchTitle), filterable on Home. Optional so
// batches persisted before this field existed still parse; every read site
// treats a missing mode as 'production' (the pre-10F default behavior).
export type BatchMode = 'testing' | 'production'

export interface StageCounts {
  total: number
  // Completed AND not flagged needsFixing (Phase 11.5E) — a flagged image
  // is still `status: 'completed'` on its own record (the pipeline itself
  // succeeded), but no longer counts toward this total. succeeded + failed
  // + cancelled + needsFixing still sums to total.
  succeeded: number
  failed: number
  cancelled: number
  needsFixing: number
}

export interface StageRef {
  // Watch stage → its underlying annotation SessionFile (kept as an internal
  // detail of the stage; the Batch is the authoritative entry point).
  sessionKey?: string
}

// Named outputs beyond a stage's single canonical outputPath — e.g. Ring &
// Bracelet's frontFullImage + frontImage (Phase 10C). Keys are individually
// optional so a future stage producing a different subset (or a differently
// named output entirely) can reuse this same interface rather than each
// stage needing its own bespoke multi-output shape.
export interface StageImageAssets {
  frontFullImage?: string
  frontImage?: string
  // Ring & Bracelet (Phase 10C/10D) — whether the shank mask found a real
  // hole/rim topology (true) or fell back to a low-confidence estimate
  // (false). Persisted here (not just in the live job's in-memory state) so
  // Batch Details — the review step this flag exists for — can surface it
  // for a historical batch too, not only a run still in progress.
  detected?: boolean
}

// A single image's terminal outcome within a stage, persisted so a stage's
// Batch Details (Phase 9E) can be rebuilt purely from the registry — never
// from PreprocessingJobContext's in-memory, run-scoped state, which does not
// survive to a later session or a different batch.
export interface StageImageRecord {
  name: string
  status: 'completed' | 'failed' | 'cancelled'
  outputPath: string | null
  assets?: StageImageAssets
  error: string | null
  durationMs: number | null
  // Manual QA review flag (Phase 11.5E) — orthogonal to `status`: an image
  // stays `status: 'completed'` when flagged (the pipeline succeeded; a
  // human just isn't satisfied with the result). Only ever set on a
  // completed image, toggled from Batch Details, never written by a
  // runner. Non-destructive — flagging never removes the image or its
  // output files, only excludes it from StageCounts.succeeded.
  needsFixing?: boolean
}

export interface StageRecord {
  type: StageType
  status: StageStatus
  inputDir: string
  outputDir: string | null
  config: Record<string, unknown>
  counts: StageCounts
  images: StageImageRecord[]
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
  images?: StageImageRecord[]
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
  mode?: BatchMode
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

