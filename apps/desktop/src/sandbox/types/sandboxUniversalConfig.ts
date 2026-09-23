// Universal Configuration state model (Phase 15.2) — Preprocessing ->
// Editing -> Post Processing, covering every product type present in the
// selected Temporary Batch in one configuration object. Sandbox-only;
// nothing here touches Legacy's Batch/Stage schema (../../types/batch.ts).
// This phase only builds/stores/validates this configuration for the UI —
// it is never executed (that's 15.3's orchestrator).
import type { UpscaleFactor } from '../../types/ipc'
import type { RotationDegrees } from '../../constants/rotation'
import type { SandboxProductType } from './sandboxProduct'
import { SANDBOX_PRODUCT_AVAILABILITY } from './sandboxProduct'
import type { SandboxTemporaryBatchDetail } from './sandboxTemporaryBatch'
import type { SandboxPostProcessingSelection } from './sandboxPostProcessing'
import { defaultPostProcessingSelection } from './sandboxPostProcessing'

// Mirrors Legacy's Preprocessing screen OperationsChoice ('both' |
// 'background_removal' | 'upscale' — see screens/Preprocessing.tsx) plus
// the Sandbox-only 'none' value (src/sandbox/types/sandboxPreprocessing.ts)
// — kept as its own type rather than reusing OperationsChoice directly,
// since that type is Preprocessing.tsx-local and not exported, and Sandbox
// genuinely has one more valid value Legacy must never gain.
export type SandboxPreprocessOperationChoice = 'both' | 'background_removal' | 'upscale' | 'none'

export interface SandboxPreprocessingConfig {
  operation: SandboxPreprocessOperationChoice
  // Meaningful only when operation is 'both' or 'upscale' — mirrors
  // Legacy's own "moot when operations excludes upscale" convention
  // (Preprocessing.tsx's handleStart).
  upscaleFactor: UpscaleFactor
  // The existing optional Trim/Rotate/Resize mini-configuration
  // (electron/services/workflowPreparation.ts's prepareForEditingHandoff),
  // reused as-is for trim/resize; rotate uses the new shared RotationDegrees
  // (Phase 15.1) instead of Legacy's EditingHandoffRotate — a genuinely
  // different, wider value set (0/45/-45/135/-135 vs none/cw/ccw/180).
  trim: boolean
  rotate: RotationDegrees
  // null = no resize step, matching prepareForEditingHandoff's own
  // "omitted means no resize" convention exactly.
  resizeToHeight: number | null
}

export function defaultPreprocessingConfig(): SandboxPreprocessingConfig {
  return { operation: 'both', upscaleFactor: 1, trim: false, rotate: 0, resizeToHeight: null }
}

// Per-product editing configuration. Deliberately minimal — Sandbox is
// Automatic-only everywhere (no Manual/Automatic selector, no manual
// annotation checkpoint; see IMPLEMENTATION_PLAN.md Phase 15 corrections),
// so there is no per-product masking knob to store yet. `available` /
// `unavailableReason` are read directly from SANDBOX_PRODUCT_AVAILABILITY
// (sandboxProduct.ts) at construction time, not re-derived by each screen.
export interface SandboxEditingConfig {
  productType: SandboxProductType
  available: boolean
  unavailableReason?: string
}

export interface SandboxUniversalConfig {
  temporaryBatchId: string
  preprocessing: SandboxPreprocessingConfig
  // Keyed by every product type actually present in the selected batch —
  // never invents an entry for a product type the batch doesn't contain.
  editingByProduct: Partial<Record<SandboxProductType, SandboxEditingConfig>>
  postProcessingByProduct: Partial<Record<SandboxProductType, SandboxPostProcessingSelection>>
}

// Builds the initial configuration for a freshly-selected Temporary Batch —
// one entry per distinct product type the batch actually contains, each
// defaulted (editing availability from the static map, post-processing
// selection from defaultPostProcessingSelection). Called once when a batch
// is selected (see SandboxWorkflowContext.selectBatchAndConfigure); nothing
// else mutates temporaryBatchId or which products are represented.
export function createInitialUniversalConfig(batch: SandboxTemporaryBatchDetail): SandboxUniversalConfig {
  const editingByProduct: SandboxUniversalConfig['editingByProduct'] = {}
  const postProcessingByProduct: SandboxUniversalConfig['postProcessingByProduct'] = {}

  for (const productType of batch.productTypes) {
    const availability = SANDBOX_PRODUCT_AVAILABILITY[productType]
    editingByProduct[productType] = {
      productType,
      available: availability.available,
      ...(availability.reason ? { unavailableReason: availability.reason } : {}),
    }
    postProcessingByProduct[productType] = defaultPostProcessingSelection(productType)
  }

  return {
    temporaryBatchId: batch.id,
    preprocessing: defaultPreprocessingConfig(),
    editingByProduct,
    postProcessingByProduct,
  }
}

export interface SandboxUniversalConfigValidation {
  ok: boolean
  errors: string[]
}

// Deliberately specific to what's actually configurable right now, not a
// generic validation framework — see the Phase 15.2 requirements' explicit
// "keep validation specific to the configuration contracts actually
// available now."
export function validateSandboxUniversalConfig(
  config: SandboxUniversalConfig | null,
  batch: SandboxTemporaryBatchDetail | null,
): SandboxUniversalConfigValidation {
  const errors: string[] = []

  if (!batch || !config) {
    return { ok: false, errors: ['Select a Temporary Batch to continue.'] }
  }
  if (batch.productTypes.length === 0) {
    errors.push('This batch has no recognizable product types.')
  } else {
    const anyAvailable = batch.productTypes.some(p => SANDBOX_PRODUCT_AVAILABILITY[p].available)
    if (!anyAvailable) {
      errors.push('None of the product types in this batch have an available processing pipeline yet.')
    }
  }
  if (config.preprocessing.resizeToHeight !== null && config.preprocessing.resizeToHeight <= 0) {
    errors.push('Resize height must be a positive number.')
  }

  return { ok: errors.length === 0, errors }
}
