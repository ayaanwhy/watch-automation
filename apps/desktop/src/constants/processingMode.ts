// Automatic / Manual processing mode (Phase 11.5C) — a shared workflow
// abstraction across every editing pipeline (Watch, Ring, Bracelet), not an
// AI-specific toggle and not a preprocessing concern:
//
//   Automatic — use the product's automated masking workflow before
//               continuing through the remainder of the editing pipeline.
//   Manual    — masking has already been completed externally; skip the
//               automated masking stage and continue with the downstream
//               editing pipeline.
//
// Independent from both BatchMode (Testing/Production — types/batch.ts) and
// the preprocessing preset (constants/preprocessingPresets.ts) — a batch
// selects all three separately.
export type ProcessingMode = 'automatic' | 'manual'

export const PROCESSING_MODE_OPTIONS: { value: ProcessingMode; label: string; description: string }[] = [
  { value: 'automatic', label: 'Automatic', description: "Run the product's automated masking workflow, then continue." },
  { value: 'manual', label: 'Manual', description: 'Masking has already been done externally — skip straight to the rest of the pipeline.' },
]

const PROCESSING_MODE_LABELS: Record<ProcessingMode, string> = {
  automatic: 'Automatic',
  manual: 'Manual',
}

// For Batch Details' config summary — mirrors formatPreset's shape in
// BatchDetails.tsx. Returns null for anything that isn't a recognized mode
// (including batches recorded before this field existed).
export function formatProcessingMode(value: unknown): string | null {
  if (value !== 'automatic' && value !== 'manual') return null
  return PROCESSING_MODE_LABELS[value]
}
