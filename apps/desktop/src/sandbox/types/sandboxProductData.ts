// Sandbox-native normalized product/measurement data model (Phase 15.5).
// Supersedes the Phase 15.0 SandboxMeasurement placeholder — inspection of
// the actual repository (packages/processing's scalingEngine.ts/
// spreadsheetParser.ts, boundaryDetection.ts, earringHandlers.ts) showed
// real evidence for a richer, product-specific shape:
//   - Legacy's own spreadsheet contract already has BOTH width and height
//     columns (spreadsheetParser.ts's REQUIRED_COLUMNS) — 'mm' is the only
//     unit that appears anywhere in this repository (no inches/cm/pixels
//     evidence), so 'mm' is the one canonical unit here too.
//   - Watch's widthMm is NOT an independent "product width" — it always
//     refers to whichever boundary `measureBy` selects (Case or Dial),
//     because processWatch()/scalingEngine.ts only ever receive one
//     widthMm paired with one scale reference (scaleBoundaries). Confusing
//     "the product's width" with "the Case-or-Dial-selected width" would
//     be a real correctness bug, not just an API nicety — hence
//     SandboxProductMeasurementInfo's 'watch' variant is structurally
//     distinct from every other product's.
//   - Ring/Bracelet's real pipeline (ringBraceletHandlers.ts's
//     RingBraceletStartPayload) consumes no measurement value at all today
//     (only an optional pixel-fraction splitY fallback) — so a generic
//     widthMm/heightMm slot for Ring/Bracelet/Necklace/Gemstone is product
//     *data* (what the Sandbox catalog may know about the item), not
//     something any current pipeline requires; missing it is a warning,
//     never an error (see validateSandboxProductData).
//   - Earring's real requirement is classification (EarringType), not a
//     numeric measurement — earringHandlers.ts's runner needs
//     Stud/Drop/Hoop, never a width/height value.
//
// Sandbox-only. Nothing here touches Legacy's Batch/Stage schema, the
// spreadsheet parser, or Watch/Ring/Bracelet/Earring's own measurement
// semantics — see normalizeSandboxProductData.ts's own header for the
// adapter boundary between this model and Legacy's real processing calls.
import type { SandboxProductType, SandboxProductAvailability } from './sandboxProduct'
import type { EarringType } from '../../constants/earringClassification'
import type { AutomationErrorCode } from './automationError'

// 'mm' is the one unit any real data in this repository ever uses
// (spreadsheet "width"/"height" columns, Watch's widthMm). Not extended to
// other units without repository evidence.
export type SandboxMeasurementUnit = 'mm'

// Reuses Phase 14's exact BoundarySource vocabulary (src/types/annotation.ts)
// for AI-boundary-derived provenance — Sandbox's Watch measurement is
// always AI-derived today (no manual annotation checkpoint in Sandbox), but
// the vocabulary stays the same one Legacy already established rather than
// inventing a parallel "derived" category that would lose the
// manual/ai/ai-adjusted distinction. 'metadata' is Sandbox's own addition
// for the one genuinely new source Sandbox has: a value supplied directly
// by the Sandbox Temporary Batch/API, the Sandbox-side analogue of
// Legacy's spreadsheet row.
export type SandboxMeasurementProvenance =
  | { kind: 'metadata'; raw: unknown }
  | { kind: 'manual' }
  | { kind: 'ai' }
  | { kind: 'ai-adjusted' }

// Watch's measurement is inherently tied to measureBy — see this file's
// header comment. `measureBy: null` and `widthMm: null` are both genuine,
// explicit "missing" states (never defaulted — Phase 15.3 previously
// defaulted absent measureBy to 'Case' inline in the editing pipeline;
// Phase 15.5 corrects that, since silently picking Case vs Dial can change
// which boundary a measurement is applied to, a real correctness risk, not
// a cosmetic default — see IMPLEMENTATION_PLAN.md's Phase 15.5 notes).
export interface SandboxWatchMeasurement {
  kind: 'watch'
  measureBy: 'Case' | 'Dial' | null
  widthMm: number | null
  unit: SandboxMeasurementUnit
  provenance: SandboxMeasurementProvenance | null
}

// Earring's real requirement is classification, not a number — see this
// file's header comment.
export interface SandboxEarringMeasurement {
  kind: 'earring'
  earringType: EarringType | null
}

// Ring/Bracelet/Necklace/Gemstone — generic catalog dimensions, not
// currently consumed by any real pipeline (see header comment), so a
// missing value here is informational, never a validation failure.
export interface SandboxGenericMeasurement {
  kind: 'generic'
  widthMm: number | null
  heightMm: number | null
  unit: SandboxMeasurementUnit
  provenance: SandboxMeasurementProvenance | null
}

// Gemstone — resizeGems needs Width, Height AND Shape (pear-shaped stones are
// force-rotated and size from Height instead of Width). All three are
// required; Shape is an opaque, case-preserved string as supplied — never
// guessed, defaulted or normalized into a closed vocabulary (the script
// only ever asks "does it contain 'pear'").
export interface SandboxGemstoneMeasurement {
  kind: 'gemstone'
  widthMm: number | null
  heightMm: number | null
  shape: string | null
  unit: SandboxMeasurementUnit
  provenance: SandboxMeasurementProvenance | null
}

export type SandboxProductMeasurementInfo =
  | SandboxWatchMeasurement
  | SandboxEarringMeasurement
  | SandboxGenericMeasurement
  | SandboxGemstoneMeasurement

// One normalized Sandbox product item — the answer to "what product is
// this, what source image, what measurement/metadata, is its pipeline
// even available" (Phase 15.5's own "a Sandbox item should be able to
// answer" list, minus the processing/artifact fields, which belong to
// SandboxRunItemState/SandboxProductPipeline — see sandboxRun.ts; this
// type is deliberately just the input-side normalized data, not a second
// copy of execution state).
export interface SandboxNormalizedProductItem {
  sku: string
  productType: SandboxProductType
  // null only when the raw source path was missing/empty — never a guessed
  // or synthesized path.
  imagePath: string | null
  availability: SandboxProductAvailability
  measurement: SandboxProductMeasurementInfo
}

export interface SandboxNormalizedTemporaryBatch {
  id: string
  name: string
  items: SandboxNormalizedProductItem[]
}

export type SandboxValidationLevel = 'valid' | 'valid_with_warnings' | 'invalid' | 'unavailable'

export interface SandboxValidationIssue {
  field: string
  message: string
  // Structured cause (automationError.ts) so callers never parse `message`.
  code?: AutomationErrorCode
}

export interface SandboxProductValidationResult {
  level: SandboxValidationLevel
  issues: SandboxValidationIssue[]
}
