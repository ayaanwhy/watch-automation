// The one authoritative Sandbox product-data normalization boundary
// (Phase 15.5). Pure functions — no Electron IPC, no React, no filesystem
// — so they're usable from the main-process orchestrator, the renderer,
// and tests identically. sandboxOrchestrator.ts/sandboxEditingPipeline.ts/
// sandboxPostProcessingRunner.ts must never re-derive/re-default this data
// themselves; they consume SandboxNormalizedProductItem via
// normalizeSandboxTemporaryBatch and (where a decision is needed)
// validateSandboxProductData, both defined here.
//
// raw SandboxTemporaryBatchImage -> normalizeSandboxProductItem ->
// SandboxNormalizedProductItem -> validateSandboxProductData ->
// SandboxProductValidationResult
//
// Deterministic: same input always produces the same normalized/validation
// output. Never guesses a missing value, never rounds/coerces a measurement,
// never invents a fallback beyond what's documented here.
import type { SandboxProductType } from '../types/sandboxProduct'
import { SANDBOX_PRODUCT_AVAILABILITY } from '../types/sandboxProduct'
import type { SandboxTemporaryBatchDetail, SandboxTemporaryBatchImage } from '../types/sandboxTemporaryBatch'
import type {
  SandboxMeasurementProvenance,
  SandboxNormalizedProductItem,
  SandboxNormalizedTemporaryBatch,
  SandboxProductMeasurementInfo,
  SandboxProductValidationResult,
  SandboxValidationIssue,
} from '../types/sandboxProductData'

// A raw mm value is only ever "present and valid" when it's a finite,
// positive number. Anything else supplied (NaN, 0, negative, non-finite)
// is recorded as present-but-invalid via provenance rather than silently
// dropped or coerced — see normalizeMm's return shape.
function normalizeMm(raw: number | undefined): { value: number | null; provenance: SandboxMeasurementProvenance | null } {
  if (raw === undefined) return { value: null, provenance: null }
  const valid = Number.isFinite(raw) && raw > 0
  return { value: valid ? raw : null, provenance: { kind: 'metadata', raw } }
}

function normalizeMeasurement(raw: SandboxTemporaryBatchImage): SandboxProductMeasurementInfo {
  if (raw.productType === 'watch') {
    const width = normalizeMm(raw.widthMm)
    return {
      kind: 'watch',
      // No default (Phase 15.3 previously defaulted an absent measureBy to
      // 'Case' inline in the editing pipeline — corrected here: guessing
      // Case vs Dial can change which real-world boundary a measurement is
      // applied to, a genuine correctness risk, not a cosmetic default).
      measureBy: raw.measureBy ?? null,
      widthMm: width.value,
      unit: 'mm',
      provenance: width.provenance,
    }
  }
  if (raw.productType === 'earring') {
    return { kind: 'earring', earringType: raw.earringType ?? null }
  }
  if (raw.productType === 'gemstone') {
    const width = normalizeMm(raw.widthMm)
    const height = normalizeMm(raw.heightMm)
    const shape = typeof raw.shape === 'string' && raw.shape.trim() !== '' ? raw.shape.trim() : null
    return {
      kind: 'gemstone',
      widthMm: width.value,
      heightMm: height.value,
      shape,
      unit: 'mm',
      provenance: width.provenance ?? height.provenance,
    }
  }
  const width = normalizeMm(raw.widthMm)
  const height = normalizeMm(raw.heightMm)
  return {
    kind: 'generic',
    widthMm: width.value,
    heightMm: height.value,
    unit: 'mm',
    // Width's provenance is representative — both dimensions share one
    // Sandbox-metadata source today (there is no repository evidence of
    // independently-sourced width vs height).
    provenance: width.provenance ?? height.provenance,
  }
}

// A truly unknown product type (outside the six-value SandboxProductType
// union — possible at runtime even though TypeScript forbids it at the
// call site, e.g. data from a future/misbehaving Sandbox API) falls back
// to this rather than crashing on an undefined SANDBOX_PRODUCT_AVAILABILITY
// lookup or, per section 4's explicit requirement, being silently mapped
// to a nearby known type.
const UNKNOWN_PRODUCT_TYPE_AVAILABILITY = { available: false, reason: 'Unknown/unsupported product type.' } as const

export function normalizeSandboxProductItem(raw: SandboxTemporaryBatchImage): SandboxNormalizedProductItem {
  return {
    sku: raw.sku,
    productType: raw.productType,
    imagePath: raw.imagePath && raw.imagePath.trim() !== '' ? raw.imagePath : null,
    availability: SANDBOX_PRODUCT_AVAILABILITY[raw.productType] ?? UNKNOWN_PRODUCT_TYPE_AVAILABILITY,
    measurement: normalizeMeasurement(raw),
  }
}

export function normalizeSandboxTemporaryBatch(raw: SandboxTemporaryBatchDetail): SandboxNormalizedTemporaryBatch {
  return {
    id: raw.id,
    name: raw.name,
    items: raw.images.map(normalizeSandboxProductItem),
  }
}

// Distinguishes VALID / VALID_WITH_WARNINGS / INVALID / UNAVAILABLE (Phase
// 15.5's own vocabulary — not a generic validation framework, just the
// checks the real normalized Sandbox model + real pipeline requirements
// actually call for):
//   UNAVAILABLE — the product's pipeline doesn't exist yet (Necklace/
//                 Gemstone today) — a capability state, never "invalid".
//   INVALID     — required data is absent or malformed for a product whose
//                 pipeline DOES exist (missing SKU/image, Watch missing
//                 measureBy/widthMm, Earring missing earringType).
//   VALID_WITH_WARNINGS — usable, but optional/currently-unconsumed data
//                 (e.g. Ring/Bracelet/Necklace/Gemstone's generic
//                 width/height) is missing or unusable.
//   VALID       — nothing missing at all.
export function validateSandboxProductData(item: SandboxNormalizedProductItem): SandboxProductValidationResult {
  if (!item.availability.available) {
    return {
      level: 'unavailable',
      issues: [{ field: 'productType', message: item.availability.reason ?? 'No pipeline available for this product type yet.' }],
    }
  }

  const issues: SandboxValidationIssue[] = []
  if (!item.sku) issues.push({ field: 'sku', message: 'Missing SKU.', code: 'SKU_MISSING' })
  if (!item.imagePath) issues.push({ field: 'imagePath', message: 'Missing or unreadable source image path.', code: 'SOURCE_IMAGE_MISSING' })

  if (item.measurement.kind === 'watch') {
    if (item.measurement.measureBy === null) {
      issues.push({ field: 'measureBy', message: 'Missing Measure By (Case/Dial) — required to interpret the width measurement.', code: 'MISSING_WATCH_MEASURE_BY' })
    }
    if (item.measurement.widthMm === null) {
      issues.push({
        field: 'widthMm',
        message: item.measurement.provenance
          ? 'Width measurement is present but not a valid positive number.'
          : 'Missing width measurement.',
        code: item.measurement.provenance ? 'MEASUREMENT_INVALID' : 'MISSING_WATCH_WIDTH',
      })
    }
  } else if (item.measurement.kind === 'earring') {
    if (item.measurement.earringType === null) {
      issues.push({ field: 'earringType', message: 'Missing Earring classification (Stud/Drop/Hoop) — required by the Earring runner.', code: 'MISSING_EARRING_CLASSIFICATION' })
    }
  } else if (item.measurement.kind === 'gemstone') {
    // resizeGems needs all three — none is ever defaulted.
    if (item.measurement.shape === null) {
      issues.push({ field: 'shape', message: 'Missing Gemstone Shape — required by resizeGems and never guessed.', code: 'MISSING_GEMSTONE_SHAPE' })
    }
    if (item.measurement.widthMm === null || item.measurement.heightMm === null) {
      issues.push({
        field: 'dimensions',
        message: item.measurement.provenance
          ? 'Gemstone width/height are present but not valid positive numbers.'
          : 'Missing Gemstone width/height.',
        code: 'INVALID_GEMSTONE_DIMENSIONS',
      })
    }
  }

  if (issues.length > 0) return { level: 'invalid', issues }

  const warnings: SandboxValidationIssue[] = []
  if (item.measurement.kind === 'generic') {
    if (item.measurement.widthMm === null || item.measurement.heightMm === null) {
      warnings.push({
        field: 'measurement',
        message: item.measurement.provenance
          ? 'Some dimensions are present but not valid positive numbers.'
          : 'No width/height measurement provided (not currently required by this product’s pipeline).',
      })
    }
  }

  if (warnings.length > 0) return { level: 'valid_with_warnings', issues: warnings }
  return { level: 'valid', issues: [] }
}

export interface SandboxProductValidationSummary {
  productType: SandboxProductType
  total: number
  valid: number
  validWithWarnings: number
  invalid: number
  unavailable: number
  // First few human-readable issue messages across invalid/warning items —
  // enough for a compact inline UI hint (Phase 15.5's "concise inline
  // status", not a per-image detail screen).
  sampleIssues: string[]
}

// Groups a normalized batch's items by product type and validates each,
// for the one small inline status Universal Configuration shows (Phase
// 15.5 explicitly forbids a new data-management screen — this is the
// entire UI surface for validation this phase adds).
export function summarizeSandboxProductValidation(items: SandboxNormalizedProductItem[]): SandboxProductValidationSummary[] {
  const byProduct = new Map<SandboxProductType, SandboxNormalizedProductItem[]>()
  for (const item of items) {
    const list = byProduct.get(item.productType) ?? []
    list.push(item)
    byProduct.set(item.productType, list)
  }

  const summaries: SandboxProductValidationSummary[] = []
  for (const [productType, productItems] of byProduct) {
    const results = productItems.map(validateSandboxProductData)
    const sampleIssues = results
      .flatMap(r => (r.level === 'invalid' || r.level === 'valid_with_warnings' ? r.issues.map(i => i.message) : []))
      .slice(0, 3)
    summaries.push({
      productType,
      total: productItems.length,
      valid: results.filter(r => r.level === 'valid').length,
      validWithWarnings: results.filter(r => r.level === 'valid_with_warnings').length,
      invalid: results.filter(r => r.level === 'invalid').length,
      unavailable: results.filter(r => r.level === 'unavailable').length,
      sampleIssues,
    })
  }
  return summaries
}

// Convenience for callers (Universal Configuration UI, orchestrator
// preflight) that need a yes/no on "does this batch have at least one
// product-type item that can actually run" without inspecting every item's
// full validation result themselves.
export function hasAnyRunnableItem(batch: SandboxNormalizedTemporaryBatch): boolean {
  return batch.items.some(item => {
    const result = validateSandboxProductData(item)
    return result.level === 'valid' || result.level === 'valid_with_warnings'
  })
}

// Re-exported for callers that only need "is this product type itself
// available" without constructing a full normalized item — mirrors
// SANDBOX_PRODUCT_AVAILABILITY directly, not a second source of truth.
export function isSandboxProductTypeAvailable(productType: SandboxProductType): boolean {
  return SANDBOX_PRODUCT_AVAILABILITY[productType]?.available ?? false
}
