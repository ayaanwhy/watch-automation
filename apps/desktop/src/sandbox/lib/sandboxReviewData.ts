// Sandbox Final Review — the one place raw run/batch/stage data becomes
// reviewable items, and the one place disposition-transition/rejection-
// input rules live (Phase 15.6). Pure — no Electron IPC, no React, no
// filesystem — mirrors normalizeSandboxProductData.ts's own contract
// exactly (independently testable, usable from main or renderer).
//
// Reuses the real Legacy StageImageRecord data every product pipeline's
// underlying Batch already carries (Ring/Bracelet/Earring/Watch all write
// their per-image outputPath/assets there — see sandboxEditingPipeline.ts)
// instead of duplicating artifact tracking into a second, Sandbox-only
// per-image store. The one exception already established (Phase 15.3):
// SandboxRunItemState for Watch — this file does NOT read that; it reads
// the same underlying Legacy stage data uniformly for every product,
// since Watch's own runSandboxWatchEditing already writes there too (see
// updateStage(batchId, 'watch', {images...}) in sandboxEditingPipeline.ts).
import type { SandboxRunDetail, SandboxExecutionStatus } from '../types/sandboxRun'
import type { SandboxNormalizedTemporaryBatch, SandboxNormalizedProductItem } from '../types/sandboxProductData'
import type { SandboxDisposition, SandboxDispositionState, SandboxEditor } from '../types/sandboxDisposition'
import type { SandboxProductType } from '../types/sandboxProduct'
import {
  sandboxReviewItemKey,
  REVIEW_STATUS_FILTERS,
  type SandboxReviewItem,
  type SandboxReviewStatusFilter,
  type SandboxReviewProductFilter,
} from '../types/sandboxReview'

// Minimal structural shape this file needs from a Legacy StageImageRecord
// (../../types/batch.ts) — kept structural rather than importing that type
// directly, so this stays a Sandbox-owned module whose only coupling to
// Legacy's shape is "has these fields", not an import dependency.
export interface SandboxReviewStageImage {
  name: string
  status: 'completed' | 'failed' | 'cancelled'
  outputPath: string | null
  error: string | null
  assets?: { compare?: string; frontFullImage?: string; frontImage?: string }
}

export interface SandboxReviewStageSource {
  productType: SandboxProductType
  // Whether this product's whole pipeline (including Post Processing)
  // completed — see sandboxReview.ts's own SandboxReviewItem.postProcessingComplete
  // doc comment for what this does and doesn't imply.
  pipelineCompleted: boolean
  images: SandboxReviewStageImage[]
}

// No node:path import — this file stays dependency-free/pure (usable from
// either the renderer or the main process; see this file's own header).
// Only strips a trailing "dot-something" segment, never anything else
// about the string (a SKU is never expected to contain a literal '.').
function stripFileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const PENDING_DISPOSITION: SandboxDisposition = {
  state: 'pending',
  reason: null,
  instructions: null,
  assignedEditor: null,
  decidedAt: null,
}

function buildUnavailableOrMissingItem(
  run: SandboxRunDetail,
  item: SandboxNormalizedProductItem,
  status: SandboxExecutionStatus,
  error: string | null,
): SandboxReviewItem {
  const key = sandboxReviewItemKey(item.productType, item.sku)
  return {
    sandboxRunId: run.id,
    productType: item.productType,
    sku: item.sku,
    processingStatus: status,
    processingError: error,
    sourceImagePath: item.imagePath,
    outputPath: null,
    compareOutputPath: null,
    measurement: item.measurement,
    disposition: run.dispositions[key] ?? PENDING_DISPOSITION,
    postProcessingComplete: false,
  }
}

// Assembles every reviewable (and non-reviewable-but-visible) item for a
// run — one entry per normalized Temporary Batch image, regardless of
// whether it ever produced real output, so failed/unavailable items stay
// visible (section 15) rather than silently dropped.
export function buildSandboxReviewItems(params: {
  run: SandboxRunDetail
  normalizedBatch: SandboxNormalizedTemporaryBatch
  stageSources: SandboxReviewStageSource[]
}): SandboxReviewItem[] {
  const { run, normalizedBatch, stageSources } = params
  const stageByProduct = new Map(stageSources.map(s => [s.productType, s]))
  const items: SandboxReviewItem[] = []

  for (const normalizedItem of normalizedBatch.items) {
    const pipeline = run.pipelines.find(p => p.productType === normalizedItem.productType)

    if (!pipeline || pipeline.status === 'unavailable') {
      items.push(buildUnavailableOrMissingItem(run, normalizedItem, 'unavailable', normalizedItem.availability.reason ?? null))
      continue
    }

    const stageSource = stageByProduct.get(normalizedItem.productType)
    // A Legacy StageImageRecord.name is bare for Watch (Sandbox's own
    // per-item dispatch uses item.sku directly — see sandboxEditingPipeline.
    // runSandboxWatchEditing) but carries the materialized source file's
    // extension for Ring/Bracelet/Earring (their real runner.py reports the
    // input filename it was given back verbatim — see
    // sandboxWorkspace.materializeProductImages's own `${sku}${ext}` naming
    // — and Legacy's own event plumbing never strips it). Comparing the
    // bare stem on both sides handles every product uniformly without
    // assuming one convention is "the" one — caught by a real end-to-end
    // test with the real Ring & Bracelet runner, not by any mock, since
    // every prior mock fixture happened to use a bare name for every
    // product alike.
    const stageImage = stageSource?.images.find(img => stripFileExtension(img.name) === normalizedItem.sku)

    if (!stageImage) {
      const status: SandboxExecutionStatus = pipeline.status === 'cancelled' ? 'cancelled' : 'failed'
      items.push(buildUnavailableOrMissingItem(run, normalizedItem, status, pipeline.error))
      continue
    }

    const key = sandboxReviewItemKey(normalizedItem.productType, normalizedItem.sku)
    items.push({
      sandboxRunId: run.id,
      productType: normalizedItem.productType,
      sku: normalizedItem.sku,
      processingStatus: stageImage.status,
      processingError: stageImage.error,
      sourceImagePath: normalizedItem.imagePath,
      outputPath: stageImage.outputPath,
      compareOutputPath: stageImage.assets?.compare ?? null,
      measurement: normalizedItem.measurement,
      disposition: run.dispositions[key] ?? PENDING_DISPOSITION,
      postProcessingComplete: stageSource?.pipelineCompleted ?? false,
    })
  }

  return items
}

// A run's Final Review is reachable only once it's reached a terminal
// processing state and has at least one genuinely reviewable item — see
// this phase's approved eligibility interpretation: Editing success makes
// an item reviewable today (Post Processing has no real implementation
// yet), but the RUN itself must still be done (not running/validating/
// draft), and 'cancelled' is never reviewable regardless of partial
// completion (explicit requirement, distinct from "entirely failed").
const NON_TERMINAL_RUN_STATUSES = new Set(['draft', 'validating', 'running'])

// Phase 15.7 — now that real post-processing scripts exist, Editing
// succeeding is no longer sufficient on its own (that was the Phase 15.6
// interim interpretation, approved only because zero real scripts existed
// anywhere in the repository at the time). An item is reviewable only once
// its pipeline's configured post-processing has genuinely completed too —
// see sandboxReviewService.gatherStageSources for where
// postProcessingComplete/outputPath get resolved against the real final
// post-processing artifact rather than the Editing stage's own output.
export function isItemReviewable(item: SandboxReviewItem): boolean {
  return item.processingStatus === 'completed' && item.outputPath !== null && item.postProcessingComplete === true
}

export function isRunReviewable(run: SandboxRunDetail, items: SandboxReviewItem[]): boolean {
  if (NON_TERMINAL_RUN_STATUSES.has(run.status)) return false
  if (run.status === 'cancelled') return false
  return items.some(isItemReviewable)
}

// Actionable = can receive a NEW approve/reject decision right now: a real
// reviewable output, and not already decided (section 10 — approved/
// rejected items never silently return to pending; re-deciding isn't
// offered since no re-review mechanism is defined anywhere in this
// product yet).
export function isItemActionable(item: SandboxReviewItem): boolean {
  return isItemReviewable(item) && item.disposition.state === 'pending'
}

export interface SandboxReviewSummary {
  total: number
  pending: number
  approved: number
  rejected: number
  // Not reviewable at all (failed/unavailable/cancelled/no output).
  notReviewable: number
}

export function summarizeSandboxReview(items: SandboxReviewItem[]): SandboxReviewSummary {
  let pending = 0
  let approved = 0
  let rejected = 0
  let notReviewable = 0
  for (const item of items) {
    if (!isItemReviewable(item)) {
      notReviewable++
      continue
    }
    if (item.disposition.state === 'approved') approved++
    else if (item.disposition.state === 'rejected') rejected++
    else pending++
  }
  return { total: items.length, pending, approved, rejected, notReviewable }
}

export function filterSandboxReviewItems(
  items: SandboxReviewItem[],
  statusFilter: SandboxReviewStatusFilter,
  productFilter: SandboxReviewProductFilter,
): SandboxReviewItem[] {
  return items.filter(item => {
    if (productFilter !== 'all' && item.productType !== productFilter) return false
    if (statusFilter === 'all') return true
    if (statusFilter === 'failed') return !isItemReviewable(item)
    return isItemReviewable(item) && item.disposition.state === statusFilter
  })
}

export { REVIEW_STATUS_FILTERS }

// Only pending -> approved and pending -> rejected are defined transitions
// (section 10) — an already-decided item never silently returns to
// pending, and there is no re-review mechanism to define here (the product
// doesn't have one yet).
export function validateDispositionTransition(
  current: SandboxDispositionState,
  next: Exclude<SandboxDispositionState, 'pending'>,
): { ok: boolean; error?: string } {
  if (current !== 'pending') {
    return { ok: false, error: `This item is already ${current} and cannot be changed to ${next}.` }
  }
  return { ok: true }
}

export interface SandboxRejectionInput {
  reason: string
  instructions?: string | null
  editor: SandboxEditor | null
}

export function validateSandboxRejectionInput(input: SandboxRejectionInput): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (!input.reason || input.reason.trim() === '') errors.push('A rejection reason is required.')
  if (!input.editor) errors.push('An assigned editor is required.')
  return { ok: errors.length === 0, errors }
}
