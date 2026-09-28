// Sandbox Final Review data model (Phase 15.6). Reuses Phase 15.0's
// SandboxDisposition (../types/sandboxDisposition.ts) verbatim — that type
// already has exactly the pending/approved/rejected + reason/instructions/
// assignedEditor shape this phase needs; nothing new is invented here for
// the disposition itself.
import type { SandboxProductType } from './sandboxProduct'
import type { SandboxExecutionStatus } from './sandboxRun'
import type { SandboxDisposition } from './sandboxDisposition'
import type { SandboxProductMeasurementInfo } from './sandboxProductData'

// One reviewable unit — assembled (never separately persisted as artifact
// data) from the underlying Legacy Batch's own StageImageRecord for this
// product's pipeline (real output paths, already the same data Batch
// Details reads — see sandboxReviewData.ts's own header) plus the
// normalized Sandbox measurement/metadata (Phase 15.5) plus the
// Sandbox-owned disposition (new this phase).
export interface SandboxReviewItem {
  sandboxRunId: string
  productType: SandboxProductType
  sku: string
  // The real Editing-stage processing outcome for this specific image —
  // distinct from the pipeline's overall status (which factors in Post
  // Processing, currently always unavailable — see this phase's approved
  // interpretation: Editing success is what makes an item reviewable
  // *today*, not the full configured pipeline).
  processingStatus: SandboxExecutionStatus
  processingError: string | null
  sourceImagePath: string | null
  outputPath: string | null
  // Only ever set when the Editing stage itself already produced one
  // (Earring's real runner does; Ring/Bracelet's compare is Post
  // Processing's job — makeCompareRB — which has no real implementation
  // yet, see Phase 15.4's investigation report, so this stays null for
  // those today, honestly, not fabricated).
  compareOutputPath: string | null
  measurement: SandboxProductMeasurementInfo
  disposition: SandboxDisposition
  // True once Post Processing has actually run successfully for this
  // item's pipeline — false today for every item (no real post-processing
  // script exists yet). Surfaced so the UI can clearly label "Post
  // Processing not yet available" per the approved review-eligibility
  // interpretation, never silently presenting an Editing-only output as a
  // finished one.
  postProcessingComplete: boolean
}

export const REVIEW_STATUS_FILTERS = ['all', 'pending', 'approved', 'rejected', 'failed'] as const
export type SandboxReviewStatusFilter = (typeof REVIEW_STATUS_FILTERS)[number]

export type SandboxReviewProductFilter = 'all' | SandboxProductType

// Composite key — a SandboxRun can contain the same-looking SKU string
// under two different product types (no cross-product uniqueness is
// guaranteed by the Sandbox API), so every disposition/handoff record and
// every review-item lookup is keyed by product+SKU together, never SKU
// alone.
export function sandboxReviewItemKey(productType: SandboxProductType, sku: string): string {
  return `${productType}:${sku}`
}

// What the Sandbox API needs to know to hand an approved output to QA
// Review (Phase 15.6, section 12) — identifiers and artifact references
// only, never a raw filesystem path exposed beyond what the mock already
// works with internally (see sandboxApiClient.ts).
export interface SandboxQaHandoffPayload {
  sandboxRunId: string
  productType: SandboxProductType
  sku: string
  outputArtifactRef: string
  compareArtifactRef: string | null
}

// What the Sandbox API needs for a rejected output's Manual Editor
// Workflow handoff (Phase 15.6, section 13).
export interface SandboxManualEditorHandoffPayload {
  sandboxRunId: string
  productType: SandboxProductType
  sku: string
  outputArtifactRef: string | null
  sourceArtifactRef: string | null
  reason: string
  instructions: string | null
  assignedEditor: { id: string; name: string }
}

export interface SandboxHandoffResult {
  ok: boolean
  error?: string
  handedOffAt: string
}

// Renderer <-> main IPC contract shapes for approve/reject (Phase 15.6) —
// defined here (src/, not electron/) so both sandboxHandlers.ts/
// sandboxReviewService.ts (main) and electron.d.ts (renderer-visible IPC
// types) import the same shape from the one place, keeping the existing
// "src/ never depends on electron/" layering intact.
export interface SandboxReviewItemKeyInput {
  productType: SandboxProductType
  sku: string
}

export interface SandboxDispositionActionResult {
  ok: boolean
  results: Record<string, { ok: boolean; error?: string }>
}
