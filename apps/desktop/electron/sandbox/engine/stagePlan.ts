// The planned per-image journey for a job — derived purely from the job's
// real configuration and the product type (never invented): which
// preprocessing sub-steps will actually run, the product's editing step(s),
// and each selected post-processing script. Pure, so it's shared by the
// engine (to initialize per-image state) and directly unit-testable.
import { resolveSelectedScripts } from '../../../src/sandbox/types/sandboxPostProcessing'
import type { SandboxItemStage } from '../../../src/sandbox/types/sandboxRun'
import type { SandboxProductType } from '../../../src/sandbox/types/sandboxProduct'
import type { SandboxPreprocessingConfig, SandboxUniversalConfig } from '../../../src/sandbox/types/sandboxUniversalConfig'

// Every product runs the universal preprocessing configuration as given.
// (Gemstone's trim-to-edges is NOT a preprocessing step: it is the Gemstone
// EDITING stage, which trims the background-removed image and saves it as the
// canonical `SKU;compare.png` — see runSandboxGemstoneEditing.) Kept as the
// one place a product could get a preprocessing override.
export function preprocessingConfigFor(_productType: SandboxProductType, config: SandboxPreprocessingConfig): SandboxPreprocessingConfig {
  return config
}

export const RING_SEGMENTATION_STAGE_ID = 'ring_segmentation'

export const EDITING_STAGE_LABELS: Record<SandboxProductType, string> = {
  watch: 'Watch Processing',
  ring: 'Ring Editing',
  bracelet: 'Bracelet Editing',
  earring: 'Earring Editing',
  gemstone: 'Trim & Save Compare',
  necklace: 'Editing',
}

export function planItemStages(productType: SandboxProductType, universal: SandboxUniversalConfig): SandboxItemStage[] {
  const pre = preprocessingConfigFor(productType, universal.preprocessing)
  const stages: SandboxItemStage[] = []
  const add = (id: string, label: string, phase: SandboxItemStage['phase'], batchGlobal = false) =>
    stages.push({ id, label, phase, status: 'pending', ...(batchGlobal ? { batchGlobal: true } : {}) })

  // Real order inside the UBG runner: upscale first, then background removal.
  if (pre.operation === 'both' || pre.operation === 'upscale') add('upscale', 'Upscaling', 'preprocessing')
  if (pre.operation === 'both' || pre.operation === 'background_removal') add('background_removal', 'Background Removal', 'preprocessing')
  if (pre.trim) add('trim', 'Trim', 'preprocessing')
  if (pre.rotate !== 0) add('rotate', 'Rotate', 'preprocessing')
  if (pre.resizeToHeight !== null) add('resize', 'Resize', 'preprocessing')

  if (productType === 'watch') add('ai_detection', 'AI Boundary Detection', 'editing')
  // Rings segment (front vs. hidden rear band) with the PixelForge-derived
  // model before the rest of Ring Editing; Bracelets keep their single CV step.
  if (productType === 'ring') add(RING_SEGMENTATION_STAGE_ID, 'Ring Segmentation', 'editing')
  add('editing', EDITING_STAGE_LABELS[productType], 'editing')

  for (const script of resolveSelectedScripts(productType, universal.postProcessingByProduct[productType] ?? {})) {
    add(`pp:${script.id}`, script.id, 'post_processing', true)
  }
  return stages
}

export function stageIdsOfPhase(stages: SandboxItemStage[] | undefined, phase: SandboxItemStage['phase']): string[] {
  return (stages ?? []).filter(s => s.phase === phase).map(s => s.id)
}
