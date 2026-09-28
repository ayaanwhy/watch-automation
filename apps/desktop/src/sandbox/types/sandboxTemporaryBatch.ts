// A Temporary Batch (Phase 15.0) is what Sandbox selects from instead of
// Legacy's Input/Output-folder model — sourced from the Sandbox API (see
// electron/sandbox/sandboxApiClient.ts). Target is per SKU-image
// (productType on each image), not a single Target selector for the whole
// batch, per the approved Phase 15 requirements.
import type { SandboxProductType } from './sandboxProduct'
import type { EarringType } from '../../constants/earringClassification'

export interface SandboxTemporaryBatchSummary {
  id: string
  name: string
  productTypes: SandboxProductType[]
  imageCount: number
}

// Fields added in Phase 15.3 — real execution surfaced three genuine data
// gaps the mock contract didn't have to represent while Sandbox was
// configuration-only:
//   widthMm     — Watch's processWatch (@wpa/processing) requires a real
//                 measurement; Legacy gets it from the spreadsheet match.
//   measureBy   — same 'Case'/'Dial' vocabulary boundaryDetection.ts/
//                 AnnotationCanvas.tsx already use.
//   earringType — Legacy's Earring pipeline classifies Stud/Drop/Hoop from
//                 a metadata spreadsheet (earringHandlers.ts's
//                 resolveEarringTypes); Sandbox has no spreadsheet, so this
//                 lets the Temporary Batch supply the classification
//                 directly instead. Reuses the exact existing EarringType
//                 vocabulary — nothing new invented.
// heightMm added in Phase 15.5 — Legacy's own real spreadsheet contract
// (packages/processing/src/data/spreadsheetParser.ts's REQUIRED_COLUMNS)
// already has both a width and a height column; this mirrors that, not an
// invented field. See src/sandbox/types/sandboxProductData.ts for how
// these raw fields become the normalized Sandbox measurement model, and
// src/sandbox/lib/normalizeSandboxProductData.ts for the one place raw ->
// normalized happens (Phase 15.3's orchestrator/editing-pipeline files no
// longer default/validate these inline — see that file's own comment).
// All optional and Sandbox-only; none of this touches Legacy's batch
// validation/spreadsheet-matching model.
export interface SandboxTemporaryBatchImage {
  sku: string
  imagePath: string
  productType: SandboxProductType
  widthMm?: number
  heightMm?: number
  measureBy?: 'Case' | 'Dial'
  earringType?: EarringType
  // Gemstone only (resizeGems requires it). NOT present in any existing
  // Legacy/Sandbox metadata — there is no Shape column in Legacy's
  // spreadsheet/product-metadata parsers — so it is an explicit required
  // input for Gemstone items and is never defaulted or inferred.
  shape?: string
}

export interface SandboxTemporaryBatchDetail extends SandboxTemporaryBatchSummary {
  images: SandboxTemporaryBatchImage[]
}
