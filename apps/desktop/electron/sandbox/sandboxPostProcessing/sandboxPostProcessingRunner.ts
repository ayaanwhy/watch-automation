// The one authoritative Sandbox post-processing entry point (Phase 15.4).
// sandboxOrchestrator.ts calls only this — it never constructs a
// subprocess or command line itself (see contracts.ts's own doc comment).
// Replaces sandboxPostProcessingPlaceholder.ts entirely (removed this
// phase) so there is exactly one path into post-processing, never two.
//
// Runs a product's configured scripts strictly sequentially, in the exact
// canonical order Phase 15.2 established (via resolveSelectedScripts —
// the same, only, source of truth for which scripts run and in what
// order; this file does not re-decide selection). Sequential, not
// Promise.all, because canonical ORDER only means something if each
// script's output is presumed to feed the next (resize -> compress ->
// compare) — with zero real script contracts available to prove otherwise
// (see the Phase 15.4 investigation report), running them concurrently
// would be guessing at a safety property nothing in this repository can
// currently confirm. Cross-PRODUCT concurrency is untouched: this
// function still runs once per product, inside sandboxOrchestrator.ts's
// existing per-product Promise.all.
import { resolveSelectedScripts } from '../../../src/sandbox/types/sandboxPostProcessing'
import { sandboxPostProcessingAdapterRegistry } from './registry'
import { sandboxPostProcessingStageDir } from '../sandboxWorkspace'
import type { SandboxProductType } from '../../../src/sandbox/types/sandboxProduct'
import type { SandboxPostProcessingSelection } from '../../../src/sandbox/types/sandboxPostProcessing'
import type { SandboxPostProcessingArtifact } from './contracts'
import type { SandboxNormalizedProductItem } from '../../../src/sandbox/types/sandboxProductData'
import { classifyThrownError, makeAutomationError, summarizeAutomationError } from '../../../src/sandbox/types/automationError'
import type { AutomationError } from '../../../src/sandbox/types/automationError'

export interface SandboxPostProcessingStageResult {
  ok: boolean
  // Set only on failure — attributes the failure to the exact script that
  // produced it (Phase 15.4's explicit error-attribution requirement:
  // "Ring / SKU123 / makeCompareRB / failed", not a generic
  // "Post processing failed"). Product/SKU context is added by the caller
  // (sandboxOrchestrator.ts already knows productType and, for Watch,
  // per-item context); this result carries the script-level half.
  error?: string
  // Structured form of `error` (automationError.ts).
  failure?: AutomationError
  failedScriptId?: string
  cancelled?: boolean
  // Every script that actually completed, in the order it ran — even on a
  // later failure, so a partial run's real progress is never lost.
  completedScriptIds: string[]
  outputDir: string
  artifacts: SandboxPostProcessingArtifact[]
}

export async function runSandboxPostProcessingForProduct(params: {
  runId: string
  productType: SandboxProductType
  batchId: string
  editingOutputDir: string
  selection: SandboxPostProcessingSelection
  isCancelled?: () => Promise<boolean>
  // The product's normalized items, handed to adapters that need per-SKU
  // data (resizeGems).
  items?: SandboxNormalizedProductItem[]
  // Real step boundaries, for live progress — each script is batch-global,
  // so this is the only granularity that exists (never a fake percentage).
  onScript?: (event: { scriptId: string; label: string; status: 'running' | 'done' | 'failed' }) => void
}): Promise<SandboxPostProcessingStageResult> {
  const scripts = resolveSelectedScripts(params.productType, params.selection)
  const completedScriptIds: string[] = []
  const artifacts: SandboxPostProcessingArtifact[] = []
  let currentInputDir = params.editingOutputDir

  if (scripts.length === 0) {
    // No product currently has an empty canonical list (every product has
    // at least compressorNew), but this stays correct if one ever did.
    return { ok: true, completedScriptIds, outputDir: currentInputDir, artifacts }
  }

  for (const script of scripts) {
    if (params.isCancelled && (await params.isCancelled())) {
      return { ok: false, cancelled: true, completedScriptIds, outputDir: currentInputDir, artifacts }
    }

    const adapter = sandboxPostProcessingAdapterRegistry[script.id]
    if (!adapter) {
      const failure = makeAutomationError('POSTPROCESSING_CAPABILITY_UNAVAILABLE', {
        stageDetail: script.id,
        technicalMessage: `No adapter registered for post-processing script '${script.id}'.`,
      })
      return {
        ok: false,
        error: summarizeAutomationError(failure),
        failure,
        failedScriptId: script.id,
        completedScriptIds,
        outputDir: currentInputDir,
        artifacts,
      }
    }

    const outputDir = sandboxPostProcessingStageDir(params.runId, params.productType, script.id)
    // Phase 15.7 — real adapters touch the real filesystem and spawn real
    // subprocesses (copyDirFlat, runPostProcessingScript), either of which
    // can throw (e.g. ENOENT on a missing input directory) rather than
    // resolving with {ok:false}. A thrown exception here must never
    // propagate up through the orchestrator as an unhandled rejection —
    // every real failure becomes an honest, attributed result exactly like
    // an adapter-reported one, never a crash.
    params.onScript?.({ scriptId: script.id, label: script.label, status: 'running' })
    let result
    try {
      result = await adapter.run({
        runId: params.runId,
        productType: params.productType,
        scriptId: script.id,
        inputDir: currentInputDir,
        outputDir,
        batchId: params.batchId,
        items: params.items,
      })
    } catch (err) {
      params.onScript?.({ scriptId: script.id, label: script.label, status: 'failed' })
      const classified = classifyThrownError(err, { stageDetail: script.id })
      const failure =
        classified.code === 'INTERNAL_ERROR'
          ? classified
          : makeAutomationError('POSTPROCESSING_PATH_FAILURE', { stageDetail: script.id, technicalMessage: classified.technicalMessage, cause: classified.cause })
      return {
        ok: false,
        error: summarizeAutomationError(failure),
        failure,
        failedScriptId: script.id,
        completedScriptIds,
        outputDir: currentInputDir,
        artifacts,
      }
    }

    if (!result.ok) {
      params.onScript?.({ scriptId: script.id, label: script.label, status: 'failed' })
      return {
        ok: false,
        error: result.error,
        failure: result.failure,
        failedScriptId: script.id,
        completedScriptIds,
        outputDir: currentInputDir,
        artifacts,
      }
    }

    params.onScript?.({ scriptId: script.id, label: script.label, status: 'done' })
    completedScriptIds.push(script.id)
    if (result.artifact) artifacts.push(result.artifact)
    currentInputDir = result.outputDir
  }

  return { ok: true, completedScriptIds, outputDir: currentInputDir, artifacts }
}
