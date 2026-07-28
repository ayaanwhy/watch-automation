// Preprocessing quality presets (Phase 11.5B; editable definitions added in
// the 11.5B follow-up). Fast / Balanced / Quality are fixed *names* — what
// each one actually configures is now user-editable from Settings and
// persisted separately (see electron/services/preprocessingPresetDefinitions.ts).
//
// The values below are the *factory defaults*: the approved specification
// (see IMPLEMENTATION_PLAN.md, "Preprocessing Presets — Approved
// Specification"), used only to initialize the persisted definitions on
// first run and as the target of Settings' "Reset to default". They are not
// read directly at run time — preprocessHandlers.ts resolves the live,
// possibly-edited definitions instead.
//
// These presets configure the preprocessing pipeline only — they never touch
// scale factor (the user's own selection is always the source of truth),
// product/target selection, or orchestration. Preprocessing.tsx is
// responsible only for letting the user pick one of these three; Settings is
// responsible for what each one means.
export type PreprocessingPreset = 'fast' | 'balanced' | 'quality'

export interface PreprocessingPresetValues {
  analysisLongestSide: number
  refineForeground: boolean
  maskBlur: number
  maskOffset: number
  maskThreshold: number | null
  maskContrast: number
  maskAntialiasScale: number
  edgeMode: 'none' | 'sharpen' | 'crisp' | 'soften'
  edgeStrength: number
  alphaSharpen: number
  samMaxImageSize: number
  samPointsPerSide: number
  samPointsPerBatch: number
  samPredIouThresh: number
  samStabilityScoreThresh: number
  samMaxMasks: number
  samMultimaskOutput: boolean
}

// A persisted preset definition — the values a preset name currently
// resolves to, plus a version incremented on every save (including a
// "Reset to default", which is itself a save). Batches record this version
// alongside the preset name for lightweight provenance, without snapshotting
// the full parameter set onto every batch.
export interface PreprocessingPresetDefinition extends PreprocessingPresetValues {
  version: number
}

export type PreprocessingPresetDefinitions = Record<PreprocessingPreset, PreprocessingPresetDefinition>

export const DEFAULT_PREPROCESSING_PRESET: PreprocessingPreset = 'balanced'

export const DEFAULT_PREPROCESSING_PRESETS: Record<PreprocessingPreset, PreprocessingPresetValues> = {
  // edgeStrength matches Balanced (1.0) so Fast's finishing behaviour stays
  // identical to Balanced — only analysis/sampling fidelity is reduced.
  fast: {
    analysisLongestSide: 768,
    refineForeground: false,
    maskBlur: 0,
    maskOffset: -2,
    maskThreshold: null,
    maskContrast: 1.0,
    maskAntialiasScale: 1,
    edgeMode: 'sharpen',
    edgeStrength: 1.0,
    alphaSharpen: 0.0,
    samMaxImageSize: 768,
    samPointsPerSide: 24,
    samPointsPerBatch: 64,
    samPredIouThresh: 0.8,
    samStabilityScoreThresh: 0.92,
    samMaxMasks: 32,
    samMultimaskOutput: false,
  },
  // The regression anchor — identical to the pre-11.5B production
  // configuration. points_per_batch stays at 16 (not raised to 64)
  // deliberately: Balanced's job is to match today's validated behaviour,
  // not to also carry a speculative optimization. edgeStrength=1.0 was
  // verified empirically against the actual pre-11.5B renderer payload
  // (which never sent --edge-strength, so the CLI's argparse default of
  // 1.0 applied) — see IMPLEMENTATION_PLAN.md for the verification method.
  balanced: {
    analysisLongestSide: 1024,
    refineForeground: false,
    maskBlur: 0,
    maskOffset: -2,
    maskThreshold: null,
    maskContrast: 1.0,
    maskAntialiasScale: 1,
    edgeMode: 'sharpen',
    edgeStrength: 1.0,
    alphaSharpen: 0.0,
    samMaxImageSize: 1024,
    samPointsPerSide: 32,
    samPointsPerBatch: 16,
    samPredIouThresh: 0.8,
    samStabilityScoreThresh: 0.92,
    samMaxMasks: 32,
    samMultimaskOutput: true,
  },
  // edgeStrength is deliberately raised to 1.5 for this milestone, alongside
  // crisp/alphaSharpen/maskContrast — see IMPLEMENTATION_PLAN.md.
  quality: {
    analysisLongestSide: 1024,
    refineForeground: false,
    maskBlur: 0,
    maskOffset: -2,
    maskThreshold: null,
    maskContrast: 1.15,
    maskAntialiasScale: 1,
    edgeMode: 'crisp',
    edgeStrength: 1.5,
    alphaSharpen: 1.0,
    samMaxImageSize: 1024,
    samPointsPerSide: 48,
    samPointsPerBatch: 64,
    samPredIouThresh: 0.8,
    samStabilityScoreThresh: 0.92,
    samMaxMasks: 32,
    samMultimaskOutput: true,
  },
}

export const PREPROCESSING_PRESET_OPTIONS: { value: PreprocessingPreset; label: string; description: string }[] = [
  { value: 'fast', label: 'Fast', description: 'Lower analysis and sampling fidelity for quicker batches.' },
  { value: 'balanced', label: 'Balanced', description: "Today's standard configuration. Recommended default." },
  { value: 'quality', label: 'Quality', description: 'Crisper edges and firmer mask contrast for the highest-fidelity output.' },
]

// Resolves a preset name to its *factory default* values — used to
// initialize persisted definitions on first run and to implement Settings'
// "Reset to default". Never used to build CLI args at run time; see
// electron/services/preprocessingPresetDefinitions.ts for the live values.
export function resolveFactoryPreset(preset: PreprocessingPreset | undefined): PreprocessingPresetValues {
  return DEFAULT_PREPROCESSING_PRESETS[preset ?? DEFAULT_PREPROCESSING_PRESET]
}

// Builds the initial set of persisted definitions (factory values, version 1
// each) for when no preprocessing-preset-definitions.json exists yet.
export function factoryPresetDefinitions(): PreprocessingPresetDefinitions {
  const presets: PreprocessingPreset[] = ['fast', 'balanced', 'quality']
  const result = {} as PreprocessingPresetDefinitions
  for (const preset of presets) {
    result[preset] = { ...DEFAULT_PREPROCESSING_PRESETS[preset], version: 1 }
  }
  return result
}

// True when a preset's active values differ from its factory defaults.
// Computed rather than stored, so Settings' "Modified" indicator can never
// drift out of sync with the actual values (see IMPLEMENTATION_PLAN.md).
export function isPresetModified(preset: PreprocessingPreset, values: PreprocessingPresetValues): boolean {
  const factory = DEFAULT_PREPROCESSING_PRESETS[preset]
  return (Object.keys(factory) as (keyof PreprocessingPresetValues)[]).some(key => factory[key] !== values[key])
}
