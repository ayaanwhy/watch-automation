// Sandbox post-processing adapter contract (Phase 15.4).
//
// One adapter per script id (imageResizeNew, removeShadows, resizeGems,
// compressorNew, autoMCFF, autoMeasurementCalculator, makeCompareRB — see
// registry.ts). The orchestrator never constructs a subprocess or command
// line itself — it only calls sandboxPostProcessingRunner.run(), which
// looks up and invokes the adapter for each configured script in canonical
// order. When a real script's invocation contract becomes available, only
// that one adapter needs to change; nothing else in this file, the
// runner, or the orchestrator does.
import type { SandboxProductType } from '../../../src/sandbox/types/sandboxProduct'
import type { SandboxNormalizedProductItem } from '../../../src/sandbox/types/sandboxProductData'
import type { AutomationError } from '../../../src/sandbox/types/automationError'

export interface SandboxPostProcessingScriptContext {
  runId: string
  productType: SandboxProductType
  scriptId: string
  // Where this script should read its input from — either the Editing
  // stage's output directory (first script in the chain) or the previous
  // script's own output directory (canonical order implies a data-flow
  // chain: resize -> compress -> compare, each consuming the prior
  // script's output — see sandboxPostProcessingRunner.ts's doc comment for
  // why this is run strictly sequentially, never Promise.all, until a real
  // contract proves otherwise).
  inputDir: string
  // Where this script should write its output — a fresh, Sandbox-owned,
  // script-specific directory (see sandboxWorkspace.sandboxPostProcessingStageDir).
  outputDir: string
  // The underlying Legacy Batch this product's pipeline is using (Phase
  // 15.3) — passed through in case a real adapter needs it for progress
  // persistence, mirroring how Editing dispatch already receives it.
  batchId: string
  // The product's normalized items (Phase 15.5's one normalization
  // boundary) — passed to adapters whose script needs per-SKU data
  // (resizeGems: width/height/shape). Adapters never re-parse raw metadata.
  items?: SandboxNormalizedProductItem[]
}

// Some scripts may produce measurement/metadata results rather than
// images (autoMeasurementCalculator is the named example — see Phase
// 15.4's own requirement not to pretend measurement output is another
// image). Represented as a distinct artifact kind so a future Phase 15.5
// consumer never has to guess which one it's looking at.
export type SandboxPostProcessingArtifact =
  | { kind: 'images'; dir: string }
  | { kind: 'measurementData'; data: Record<string, unknown> }

export type SandboxPostProcessingAdapterResult =
  | { ok: true; outputDir: string; artifact?: SandboxPostProcessingArtifact }
  | { ok: false; error: string; unavailable?: boolean; failure?: AutomationError }

// Documents what the REAL implementation would need to prove, once one
// exists, before this script could safely run concurrently with anything
// else. 'unknown-unavailable' is the only value any adapter in this phase
// can honestly declare — see unavailableAdapter.ts.
export type SandboxPostProcessingConcurrency =
  | 'safe-concurrent'
  | 'requires-serialization'
  | 'batch-global'
  | 'unknown-unavailable'

export interface SandboxPostProcessingAdapter {
  scriptId: string
  concurrency: SandboxPostProcessingConcurrency
  run(context: SandboxPostProcessingScriptContext): Promise<SandboxPostProcessingAdapterResult>
}
