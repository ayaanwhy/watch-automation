// SandboxRun (Phase 15.0, extended Phase 15.3) — the Sandbox-level
// grouping/user-facing abstraction over the approved workflow: Temporary
// Batch -> Universal Config -> Preprocessing -> Editing -> Post Processing
// -> Unified Final Review -> Approved/Sandbox QA or Rejected/Manual Editor.
//
// Option B architecture (approved): a SandboxRun groups one or more
// SandboxProductPipeline entries, each of which executes via an ordinary,
// unmodified Legacy Batch record (see ../../types/batch.ts) — Legacy's
// Batch/Stage schema is never touched to understand Sandbox. Sandbox owns
// the grouping relationship entirely on its own side; the Sandbox UI
// exposes SandboxRun/pipeline concepts, never raw Legacy batch ids.
import type { SandboxProductType } from './sandboxProduct'
import type { SandboxDisposition } from './sandboxDisposition'
import type { SandboxHandoffResult } from './sandboxReview'
import type { AutomationError } from './automationError'
import type { SandboxNormalizedProductItem } from './sandboxProductData'

// Top-level run lifecycle (Phase 15.3) — coarser than per-product/per-item
// state below, since a run spans every product pipeline it contains.
// 'draft' covers "created, not yet started" (a SandboxRun record can exist
// before execution begins — see sandboxRunRegistry.createSandboxRun, still
// called at Universal Configuration time in 15.2's flow). Approval/
// rejection/QA states are explicitly out of scope for this phase (15.6) —
// not added here.
export type SandboxRunStatus =
  | 'draft'
  | 'validating'
  | 'running'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled'

// Per-product-pipeline and per-item execution state (Phase 15.3) — a
// narrower vocabulary than SandboxRunStatus on purpose: an individual
// pipeline/item is never itself "validating" or "partially_completed",
// those are whole-run rollups. 'unavailable' is a genuine, permanent
// terminal state (Necklace/Gemstone today) — distinct from 'failed', which
// implies a pipeline that was attempted and didn't succeed.
export type SandboxExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unavailable' | 'cancelled'

// One product's execution within a SandboxRun. batchId is the id of the
// ordinary Legacy Batch record actually running this product's pipeline
// (created internally via electron/services/batchRegistry.ts, called
// directly from the main-process orchestrator — never surfaced to the
// Sandbox UI directly, and never via IPC round-trip since the orchestrator
// already runs in the main process). null for a product with no batch yet
// (not started) or that will never get one (unavailable).
export interface SandboxProductPipeline {
  productType: SandboxProductType
  batchId: string | null
  status: SandboxExecutionStatus
  error: string | null
  // Which stage this pipeline is currently on / last reached — mirrors
  // Legacy's StageType vocabulary loosely, kept as a plain string union
  // scoped to what Sandbox's workflow actually has stages for (Phase
  // 15.2's diagram): preprocessing -> editing -> post_processing. null
  // before the pipeline has started.
  stage: 'preprocessing' | 'editing' | 'post_processing' | null
  // Phase 15.7 — the directory the LAST successfully-run post-processing
  // script for this product actually wrote its final output to (see
  // sandboxPostProcessingRunner.ts's own outputDir chaining). null until
  // post-processing has genuinely completed for this pipeline. This is
  // what Final Review now resolves each image's real final artifact
  // against (see sandboxReviewService.gatherStageSources) instead of the
  // Editing stage's own output — Editing succeeding is no longer
  // sufficient for reviewability now that real post-processing scripts
  // exist (see sandboxReviewData.isItemReviewable).
  postProcessingOutputDir: string | null
  // Phase 15.7 — non-image artifacts real post-processing scripts produced
  // (e.g. autoMCFF's dimensions.csv, autoMeasurementCalculator's
  // measurements.xlsx) — kept for traceability/debugging; Final Review
  // does not currently render these (see Phase 15.7's own non-goals: no
  // new review UI beyond fixing artifact selection/eligibility).
  postProcessingArtifacts: SandboxPostProcessingArtifactRecord[]
  // Structured failure (automationError.ts) — present exactly when status is
  // 'failed'. `error` above stays as the one-line human summary of it.
  // Optional: records persisted before the automation-engine hardening pass
  // don't have it.
  failure?: AutomationError | null
  // What the pipeline is doing right now, in plain words ("Running
  // compressorNew — batch post-processing"). Never a fabricated percentage.
  activity?: string | null
}

// A plain-data mirror of SandboxPostProcessingArtifact (electron/sandbox/
// sandboxPostProcessing/contracts.ts) — duplicated as a type rather than
// imported, since sandboxRun.ts is a src/ (renderer-visible) type and
// contracts.ts lives under electron/ (see this file's own established
// src/-never-depends-on-electron/ layering, e.g. sandboxReviewData.ts's own
// note). Structurally identical (must stay so — sandboxOrchestrator.ts
// assigns a SandboxPostProcessingArtifact[] directly to this type); kept in
// sync by hand.
export type SandboxPostProcessingArtifactRecord =
  | { kind: 'images'; dir: string }
  | { kind: 'measurementData'; data: Record<string, unknown> }

// Per-image/per-SKU execution record (Phase 15.3) — the progress model's
// finest grain (see sandboxOrchestrator.ts's progress accounting). Not
// persisted as a Legacy StageImageRecord: Watch has no subprocess/NDJSON
// stream of its own here (the orchestrator drives it directly, image by
// image), so this is Sandbox's own minimal shape rather than reusing
// Legacy's (which assumes a subprocess runner's event protocol).
export interface SandboxRunItemState {
  sku: string
  productType: SandboxProductType
  status: SandboxExecutionStatus
  error: string | null
  // Automation-engine hardening pass — the per-image progress record for
  // EVERY product type (not just Watch). All optional: records persisted
  // before this pass lack them, and Watch's direct-drive code builds items
  // without them (the orchestrator's progress recorder fills them in).
  stages?: SandboxItemStage[]
  // Label of the stage currently running for this image, if any.
  stage?: string | null
  failure?: AutomationError | null
  startedAt?: string | null
  finishedAt?: string | null
  // Retry Image: which attempt this is (1 = the original), and the failures
  // of earlier attempts, oldest first — a retry never erases what went wrong
  // before.
  attempt?: number
  history?: SandboxItemAttempt[]
}

export type SandboxRestartBoundary = 'preprocessing' | 'editing' | 'post_processing'

export interface SandboxItemAttempt {
  attempt: number
  failure: AutomationError | null
  failedAt: string | null
  // Where the NEXT attempt restarted, derived from this attempt's persisted
  // per-stage state.
  restartedFrom: SandboxRestartBoundary
}

// One planned step in an image's journey. Derived from the run's real
// configuration (never invented): preprocessing sub-steps that will run,
// the product's editing step(s), and each selected post-processing script.
export type SandboxItemStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface SandboxItemStage {
  id: string
  label: string
  phase: 'preprocessing' | 'editing' | 'post_processing'
  status: SandboxItemStageStatus
  // Batch-global post-processing scripts operate on a whole product
  // directory at once — there is no per-image progress inside them, so the
  // UI shows "batch post-processing", never a fabricated per-image percent.
  batchGlobal?: boolean
}

export interface SandboxRunSummary {
  id: string
  seq: number
  title: string
  status: SandboxRunStatus
  temporaryBatchId: string
  productTypes: SandboxProductType[]
  createdAt: string
  updatedAt: string
}

export interface SandboxRunDetail extends SandboxRunSummary {
  pipelines: SandboxProductPipeline[]
  // Per-item state for products the orchestrator drives directly
  // (currently: Watch). Ring/Bracelet/Earring/Preprocessing's per-image
  // progress instead lives on their underlying Legacy Batch's own stage
  // (StageImageRecord[]/StageCounts — see pipelines[].batchId), reusing
  // that existing, already-correct model rather than duplicating it here.
  items: SandboxRunItemState[]
  // Universal Configuration snapshot for this run. Left as an open record
  // here rather than a named shape — Universal Configuration's actual
  // fields are 15.2 scope (one screen, thin visual arrows, shared
  // operations); locking its shape now would mean guessing it.
  universalConfig: Record<string, unknown>
  // Set once cancellation is requested (see sandboxOrchestrator.cancelRun)
  // — the orchestrator checks this before starting each new unit of queued
  // work; already-in-flight work is allowed to finish rather than being
  // force-terminated (Sharp/Python operations aren't safely interruptible
  // mid-operation — same rationale as subprocessRunner.ts's own
  // cooperative-cancel-only design).
  cancelRequested: boolean
  // Phase 15.6 — Sandbox Final Review's disposition/handoff state, keyed by
  // sandboxReviewItemKey(productType, sku) (../lib/sandboxReviewData.ts) —
  // never by SKU alone, since two products in the same run could share a
  // SKU string. Sandbox-owned; Legacy's Batch/Stage schema is untouched.
  // Absent from the map means 'pending' (see buildSandboxReviewItems's own
  // default) — a pending item is never written here just to represent "no
  // decision yet", only an actual approve/reject adds an entry.
  dispositions: Record<string, SandboxDisposition>
  // One handoff attempt's outcome per item, same key — lets a failed
  // handoff be identified/retried later without re-deciding the
  // disposition, and prevents a duplicate handoff for an item that already
  // succeeded (Phase 15.6 section 14).
  handoffResults: Record<string, SandboxHandoffResult>
  // Run-level structured failure (preflight/interrupted/every product
  // failed...), set when status is 'failed'. Optional for older records.
  failure?: AutomationError | null
  // The normalized items this run was created from (the engine's single
  // normalization boundary), so an individual image can be retried later —
  // after a reload or restart — without the original Temporary Batch source
  // being consulted again.
  inputItems?: SandboxNormalizedProductItem[]
  // When execution actually began/ended (createdAt is when the record was
  // created) — the basis for elapsed time, rate and ETA.
  startedAt?: string | null
  finishedAt?: string | null
}
