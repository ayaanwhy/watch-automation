// Shared Legacy/Sandbox presentation rule for preprocessing operations
// (Phase 15.1). Mirrors processingMode.ts's shape (a formatter over raw
// persisted/`unknown` config values, for Batch Details' summary) plus one
// small predicate both Legacy's live Preprocessing screen and Batch
// Details' persisted-config summary can share, without forcing them onto
// identical label wording (they name different things — a dropdown choice
// vs. a resolved outcome — see Preprocessing.tsx and BatchDetails.tsx's own
// call sites for how each applies this).
import type { PreprocessOperation, UpscaleFactor } from '../types/ipc'

// Phase 11.5F renamed upscale factor 1 to "None" — copies images without
// modification. When both operations are selected together and the factor
// is None, the upscale step did nothing, so a combined label should read
// as if only Background Removal ran. 'upscale' selected on its own is
// unaffected — it's still worth surfacing that the (no-op) step ran when
// it's the only thing selected.
export function shouldSuppressUpscaleFromCombinedLabel(
  operations: PreprocessOperation[],
  scaleFactor: UpscaleFactor,
): boolean {
  return scaleFactor === 1 && operations.includes('background_removal') && operations.includes('upscale')
}

const OPERATION_LABELS: Record<PreprocessOperation, string> = {
  background_removal: 'Background Removal',
  upscale: 'Upscaling',
}

// For Batch Details' persisted config summary — operations is stored as an
// array (['background_removal', 'upscale']); a plain String(value) would
// render it as a raw comma-joined string, so it gets this dedicated
// formatter instead, same as formatPreset/formatProcessingMode.
export function formatPreprocessingOperations(operationsValue: unknown, scaleFactorValue: unknown): string | null {
  if (!Array.isArray(operationsValue) || operationsValue.length === 0) return null
  const operations = operationsValue as PreprocessOperation[]
  const scaleFactor = (scaleFactorValue === 1 || scaleFactorValue === '1' ? 1 : scaleFactorValue) as UpscaleFactor

  const visible = shouldSuppressUpscaleFromCombinedLabel(operations, scaleFactor)
    ? operations.filter(op => op !== 'upscale')
    : operations

  return visible.map(op => OPERATION_LABELS[op] ?? String(op)).join(' + ')
}
