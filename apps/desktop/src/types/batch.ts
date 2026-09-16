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
  // Post-Phase-13 polish (queueing) — a Start request accepted while another
  // job of the same pipeline type is already running. Purely a renderer-side
  // wait state (see useSubprocessJob's queue) — no subprocess exists yet for
  // this stage. Never persists across an app restart (nothing survives to
  // drain it), so reconcileBatchesOnStartup resets it exactly like an
  // interrupted 'running' stage.
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type BatchStatus =
  | 'draft'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

// Normalized product classification, derived from whichever stage carries
// it (preprocessing's config.objectType, or watch/editing's config.product —
// 'watch' is definitional for a 'watch' stage, no config lookup needed) —
// computed once in batchModel.ts's recompute(), mirroring how
// currentStage/counts are already cached rather than read live per-consumer.
// Null when the batch has no stage yet, or that stage hasn't recorded one
// (e.g. a preprocessing batch before its first job start).
export type BatchProductType = 'watch' | 'ring' | 'bracelet' | 'earring' | 'generic'

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
  // Images whose assets.detected === false (Phase 13D, additive) — the
  // machine's own low-confidence signal (Ring/Bracelet's shank mask,
  // Earring Hoop's split detection), independent of needsFixing (human
  // judgment). Feeds the Dashboard's Attention row "Waiting review" tile
  // without a per-batch detail fetch. Not a subset of needsFixing or vice
  // versa — an image can be low-confidence and still un-reviewed, or
  // reviewed (needsFixing) despite high confidence.
  lowConfidence: number
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
  // Earring (Phase 12C) — the immutable output of Universal Background
  // Removal + trim, which every editing operation derives from but never
  // modifies (Phase 12 Architectural Rules). Deliberately its own field
  // rather than reusing frontFullImage: Stud/Drop only ever produce
  // compare + frontImage, never a frontFullImage (that's Hoop-specific,
  // Phase 12D). BatchDetails.tsx's generic editing-stage mapping falls back
  // to this when frontFullImage is absent, so the existing preview panel
  // renders it without needing an Earring-specific component.
  compare?: string
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
  productType: BatchProductType | null
  counts: StageCounts
  durationMs: number | null
  createdAt: string
  updatedAt: string
}

// Full persisted record (index summary + per-stage detail).
export interface BatchDetailRecord extends BatchSummaryRecord {
  stages: StageRecord[]
}

