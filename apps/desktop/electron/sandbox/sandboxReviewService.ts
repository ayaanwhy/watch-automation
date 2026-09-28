// Sandbox Final Review service (Phase 15.6) — assembles review items for a
// run (reusing the real Legacy Batch stage data every product pipeline
// already writes — see sandboxReviewData.ts's own header) and performs
// approve/reject, including the QA/Manual-Editor handoff through the
// existing SandboxApiClient abstraction (currently MockSandboxApiClient).
// The renderer never talks to SandboxApiClient directly — only through
// sandboxHandlers.ts's thin IPC wrapper around this file, exactly like
// every other Sandbox execution concern (Phase 15.3's own architecture).
import { basename, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { getBatch } from '../services/batchRegistry'
import { sandboxApiClient } from './sandboxApiClient'
import { resolveTemporaryBatchDetail } from './temporaryBatchResolver'
import { getSandboxRun, updateSandboxRun } from './sandboxRunRegistry'
import { normalizeSandboxTemporaryBatch } from '../../src/sandbox/lib/normalizeSandboxProductData'
import {
  buildSandboxReviewItems,
  isItemActionable,
  isItemReviewable,
  validateDispositionTransition,
  validateSandboxRejectionInput,
} from '../../src/sandbox/lib/sandboxReviewData'
import { sandboxReviewItemKey } from '../../src/sandbox/types/sandboxReview'
import type { SandboxReviewStageSource } from '../../src/sandbox/lib/sandboxReviewData'
import type {
  SandboxReviewItem,
  SandboxReviewItemKeyInput,
  SandboxDispositionActionResult,
} from '../../src/sandbox/types/sandboxReview'
import type { SandboxDisposition, SandboxEditor } from '../../src/sandbox/types/sandboxDisposition'
import type { SandboxRunDetail } from '../../src/sandbox/types/sandboxRun'

// Serializes review actions per run — mirrors sandboxOrchestrator.ts's own
// queueRunUpdate (and sandboxRunRegistry.ts's/batchRegistry.ts's
// serializeWrite): two approve/reject calls against the same run must
// never read-then-write on a stale copy of dispositions/handoffResults.
const reviewActionQueues = new Map<string, Promise<unknown>>()
function queueReviewAction<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prior = reviewActionQueues.get(runId) ?? Promise.resolve()
  const next = prior.then(fn, fn)
  reviewActionQueues.set(
    runId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// Phase 15.7 — resolves a single Editing-stage output path to its real
// final post-processing artifact (same basename, inside the pipeline's
// postProcessingOutputDir — every real adapter preserves each image's
// filename end to end; see each adapter's own doc comment). Returns null
// if post-processing hasn't completed for this pipeline, OR if the
// expected file genuinely isn't there despite the pipeline claiming
// success — this never fabricates a path that doesn't exist on disk (no
// false success, matching every other artifact-selection rule in this
// file).
// Gemstone is the one product whose final artifact has a different name from
// its editing artifact: editing saves the trimmed `SKU;compare.png`;
// resizeGems writes the final `SKU;frontImage.png` beside an unchanged
// compare. So a Gemstone's final output maps ;compare -> ;frontImage (its
// compare asset stays the compare — the before/reference artifact).
export function finalArtifactName(productType: string, editingBasename: string): string {
  return productType === 'gemstone' ? editingBasename.replace(/;compare(\.[^.]+)$/, ';frontImage$1') : editingBasename
}

async function resolveFinalArtifactPath(
  postProcessingOutputDir: string | null,
  editingOutputPath: string | null,
  productType: string,
  asFinal = true,
): Promise<string | null> {
  if (!postProcessingOutputDir || !editingOutputPath) return null
  const name = asFinal ? finalArtifactName(productType, basename(editingOutputPath)) : basename(editingOutputPath)
  const candidate = join(postProcessingOutputDir, name)
  return (await fileExists(candidate)) ? candidate : null
}

async function gatherStageSources(run: SandboxRunDetail): Promise<SandboxReviewStageSource[]> {
  const sources: SandboxReviewStageSource[] = []
  for (const pipeline of run.pipelines) {
    if (!pipeline.batchId) continue
    const batch = await getBatch(pipeline.batchId)
    if (!batch) continue
    const stage = batch.stages.find(s => s.type === 'editing' || s.type === 'watch')
    if (!stage) continue

    const postProcessingDone = pipeline.status === 'completed' && pipeline.postProcessingOutputDir !== null

    const images = await Promise.all(
      stage.images.map(async img => {
        if (img.status !== 'completed' || !postProcessingDone) {
          // Not reviewable regardless of the remap below — surface the
          // Editing-stage output as-is for display/debugging context (see
          // isItemReviewable's own Phase 15.7 gate for why this alone
          // isn't enough to make the item actionable).
          return { name: img.name, status: img.status, outputPath: img.outputPath, error: img.error, assets: img.assets }
        }

        const finalOutputPath = await resolveFinalArtifactPath(pipeline.postProcessingOutputDir, img.outputPath, pipeline.productType)
        const finalCompare = img.assets?.compare
          ? await resolveFinalArtifactPath(pipeline.postProcessingOutputDir, img.assets.compare, pipeline.productType, false)
          : null

        return {
          name: img.name,
          status: img.status,
          // A file post-processing genuinely completed for, but whose
          // specific final artifact is unexpectedly missing, is treated
          // as not having usable output — never falls back to the
          // pre-post-processing Editing path, which would silently make
          // Final Review show/approve un-post-processed content.
          outputPath: finalOutputPath,
          error: img.error,
          assets: finalCompare ? { ...img.assets, compare: finalCompare } : img.assets,
        }
      }),
    )

    sources.push({
      productType: pipeline.productType,
      pipelineCompleted: pipeline.status === 'completed',
      images,
    })
  }
  return sources
}

export async function getSandboxReviewItems(runId: string): Promise<SandboxReviewItem[] | null> {
  const run = await getSandboxRun(runId)
  if (!run) return null
  const batch = await resolveTemporaryBatchDetail(run.temporaryBatchId)
  if (!batch) return null
  const normalizedBatch = normalizeSandboxTemporaryBatch(batch)
  const stageSources = await gatherStageSources(run)
  return buildSandboxReviewItems({ run, normalizedBatch, stageSources })
}

export async function approveSandboxItems(
  runId: string,
  keys: SandboxReviewItemKeyInput[],
): Promise<SandboxDispositionActionResult> {
  return queueReviewAction(runId, async () => {
    const items = await getSandboxReviewItems(runId)
    const run = await getSandboxRun(runId)
    if (!items || !run) return { ok: false, results: {} }

    const results: Record<string, { ok: boolean; error?: string }> = {}
    const dispositionPatch: Record<string, SandboxDisposition> = {}
    const handoffPatch: Record<string, { ok: boolean; error?: string; handedOffAt: string }> = {}

    for (const { productType, sku } of keys) {
      const key = sandboxReviewItemKey(productType, sku)
      const item = items.find(i => i.productType === productType && i.sku === sku)
      if (!item) {
        results[key] = { ok: false, error: 'Item not found in this run.' }
        continue
      }
      if (!isItemReviewable(item)) {
        results[key] = { ok: false, error: 'This item has no usable output and cannot be approved.' }
        continue
      }
      const transition = validateDispositionTransition(item.disposition.state, 'approved')
      if (!transition.ok) {
        results[key] = { ok: false, error: transition.error }
        continue
      }
      if (!isItemActionable(item)) {
        results[key] = { ok: false, error: 'This item is not actionable.' }
        continue
      }

      const now = new Date().toISOString()
      dispositionPatch[key] = { state: 'approved', reason: null, instructions: null, assignedEditor: null, decidedAt: now }

      const handoff = await sandboxApiClient.handoffApprovedToQa({
        sandboxRunId: runId,
        productType,
        sku,
        outputArtifactRef: item.outputPath ?? '',
        compareArtifactRef: item.compareOutputPath,
      })
      handoffPatch[key] = { ok: handoff.ok, error: handoff.error, handedOffAt: now }
      results[key] = handoff
    }

    if (Object.keys(dispositionPatch).length > 0) {
      await updateSandboxRun(runId, {
        dispositions: { ...run.dispositions, ...dispositionPatch },
        handoffResults: { ...run.handoffResults, ...handoffPatch },
      })
    }

    return { ok: Object.values(results).every(r => r.ok), results }
  })
}

export interface SandboxRejectItemsInput {
  keys: SandboxReviewItemKeyInput[]
  reason: string
  instructions?: string | null
  editor: SandboxEditor | null
}

export async function rejectSandboxItems(runId: string, input: SandboxRejectItemsInput): Promise<SandboxDispositionActionResult> {
  const validation = validateSandboxRejectionInput({ reason: input.reason, instructions: input.instructions, editor: input.editor })
  if (!validation.ok) {
    return { ok: false, results: Object.fromEntries(input.keys.map(k => [sandboxReviewItemKey(k.productType, k.sku), { ok: false, error: validation.errors.join(' ') }])) }
  }
  const editor = input.editor!

  return queueReviewAction(runId, async () => {
    const items = await getSandboxReviewItems(runId)
    const run = await getSandboxRun(runId)
    if (!items || !run) return { ok: false, results: {} }

    const results: Record<string, { ok: boolean; error?: string }> = {}
    const dispositionPatch: Record<string, SandboxDisposition> = {}
    const handoffPatch: Record<string, { ok: boolean; error?: string; handedOffAt: string }> = {}

    for (const { productType, sku } of input.keys) {
      const key = sandboxReviewItemKey(productType, sku)
      const item = items.find(i => i.productType === productType && i.sku === sku)
      if (!item) {
        results[key] = { ok: false, error: 'Item not found in this run.' }
        continue
      }
      if (!isItemReviewable(item)) {
        results[key] = { ok: false, error: 'This item has no usable output and cannot be rejected.' }
        continue
      }
      const transition = validateDispositionTransition(item.disposition.state, 'rejected')
      if (!transition.ok) {
        results[key] = { ok: false, error: transition.error }
        continue
      }

      const now = new Date().toISOString()
      dispositionPatch[key] = {
        state: 'rejected',
        reason: input.reason,
        instructions: input.instructions?.trim() ? input.instructions.trim() : null,
        assignedEditor: editor,
        decidedAt: now,
      }

      const handoff = await sandboxApiClient.handoffRejectedToManualEditor({
        sandboxRunId: runId,
        productType,
        sku,
        outputArtifactRef: item.outputPath,
        sourceArtifactRef: item.sourceImagePath,
        reason: input.reason,
        instructions: dispositionPatch[key].instructions,
        assignedEditor: editor,
      })
      handoffPatch[key] = { ok: handoff.ok, error: handoff.error, handedOffAt: now }
      results[key] = handoff
    }

    if (Object.keys(dispositionPatch).length > 0) {
      await updateSandboxRun(runId, {
        dispositions: { ...run.dispositions, ...dispositionPatch },
        handoffResults: { ...run.handoffResults, ...handoffPatch },
      })
    }

    return { ok: Object.values(results).every(r => r.ok), results }
  })
}
