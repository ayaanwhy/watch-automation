// The one place a Sandbox post-processing script id maps to its adapter.
// Phase 15.4 (no real scripts existed) mapped every entry to the shared
// "unavailable" adapter. Phase 15.7 replaced six of those with real
// adapters once the actual post-scripts/ implementations were supplied and
// inspected (see each real adapter's own doc comment for its script's real
// contract) — sandboxPostProcessingRunner.ts and the orchestrator are
// unaffected either way; only this map changed.
//
// resizeGems (Gemstone) is real as of the automation-engine hardening pass:
// a headless wrapper (postProcessing/resizeGems/runner.py) fed by Sandbox's
// normalized Gemstone data. Shape has no source in any existing Legacy
// metadata, so it is an explicit required per-item input validated before
// execution (validateSandboxProductData) — never defaulted.
//
// Deliberately excludes autoMCForIndividual — not part of the Phase 15.2
// configuration model (src/sandbox/types/sandboxPostProcessing.ts) and, per
// an explicit product decision reconfirmed in Phase 15.7, still not added
// (it requires an external metadata spreadsheet Sandbox has no equivalent
// of, and it wasn't in the original canonical-list scope this Sandbox
// effort was given).
import { resizeGemsAdapter } from './resizeGemsAdapter'
import { imageResizeNewAdapter } from './imageResizeNewAdapter'
import { compressorNewAdapter } from './compressorNewAdapter'
import { makeCompareRBAdapter } from './makeCompareRBAdapter'
import { autoMCFFAdapter } from './autoMCFFAdapter'
import { removeShadowsAdapter } from './removeShadowsAdapter'
import { autoMeasurementCalculatorAdapter } from './autoMeasurementCalculatorAdapter'
import type { SandboxPostProcessingAdapter } from './contracts'

export const sandboxPostProcessingAdapterRegistry: Record<string, SandboxPostProcessingAdapter> = {
  imageResizeNew: imageResizeNewAdapter,
  removeShadows: removeShadowsAdapter,
  resizeGems: resizeGemsAdapter,
  compressorNew: compressorNewAdapter,
  autoMCFF: autoMCFFAdapter,
  autoMeasurementCalculator: autoMeasurementCalculatorAdapter,
  makeCompareRB: makeCompareRBAdapter,
}
