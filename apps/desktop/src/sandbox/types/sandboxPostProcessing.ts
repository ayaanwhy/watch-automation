// Sandbox-only post-processing script catalog (Phase 15.2). Represents the
// known canonical script list/order per product type, supplied directly by
// the user — nothing here is invented, and nothing here executes anything
// (that's a later phase; see sandboxOrchestrator, not yet built). Script
// ids are the exact script names as given, not slugified/relabeled.
import type { SandboxProductType } from './sandboxProduct'

export interface SandboxPostProcessingScript {
  id: string
  label: string
  // Compulsory scripts are always included and cannot be disabled from the
  // UI. Optional scripts default to disabled and are individually
  // toggleable — see resolveSelectedScripts below.
  compulsory: boolean
}

// Canonical order matters — this array's order IS the fixed execution
// order for that product; nothing reorders it (no drag-and-drop, per the
// explicit requirement).
export const SANDBOX_POST_PROCESSING_SCRIPTS: Record<SandboxProductType, SandboxPostProcessingScript[]> = {
  ring: [
    { id: 'imageResizeNew', label: 'Image Resize', compulsory: true },
    { id: 'compressorNew', label: 'Compressor', compulsory: true },
    { id: 'makeCompareRB', label: 'Make Compare', compulsory: true },
    { id: 'autoMCFF', label: 'Auto MCFF', compulsory: false },
  ],
  bracelet: [
    { id: 'imageResizeNew', label: 'Image Resize', compulsory: true },
    { id: 'compressorNew', label: 'Compressor', compulsory: true },
    { id: 'makeCompareRB', label: 'Make Compare', compulsory: true },
    { id: 'autoMCFF', label: 'Auto MCFF', compulsory: false },
  ],
  earring: [
    { id: 'compressorNew', label: 'Compressor', compulsory: true },
    { id: 'autoMeasurementCalculator', label: 'Auto Measurement Calculator', compulsory: false },
  ],
  necklace: [
    { id: 'compressorNew', label: 'Compressor', compulsory: true },
  ],
  watch: [
    { id: 'removeShadows', label: 'Remove Shadows', compulsory: true },
    { id: 'compressorNew', label: 'Compressor', compulsory: true },
  ],
  gemstone: [
    { id: 'resizeGems', label: 'Resize Gems', compulsory: true },
    { id: 'compressorNew', label: 'Compressor', compulsory: true },
  ],
}

// Which optional scripts are enabled for one product, keyed by script id.
// Compulsory scripts are never represented here — they're implied always-on
// (see resolveSelectedScripts).
export type SandboxPostProcessingSelection = Record<string, boolean>

// Every compulsory script defaults on; every optional script defaults off —
// matches "compulsory scripts are preselected and cannot be disabled."
export function defaultPostProcessingSelection(productType: SandboxProductType): SandboxPostProcessingSelection {
  const selection: SandboxPostProcessingSelection = {}
  for (const script of SANDBOX_POST_PROCESSING_SCRIPTS[productType]) {
    if (!script.compulsory) selection[script.id] = false
  }
  return selection
}

// Resolves which scripts actually run, in canonical order: every compulsory
// script plus whichever optional scripts are toggled on in `selection`.
export function resolveSelectedScripts(
  productType: SandboxProductType,
  selection: SandboxPostProcessingSelection,
): SandboxPostProcessingScript[] {
  return SANDBOX_POST_PROCESSING_SCRIPTS[productType].filter(script => script.compulsory || selection[script.id] === true)
}
