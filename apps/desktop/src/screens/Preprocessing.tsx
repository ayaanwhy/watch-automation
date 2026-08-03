import { useState } from 'react'
import { PathField } from '../components/PathField'
import { SnapSlider } from '../components/SnapSlider'
import { Select } from '../components/ui/Select'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { ConsoleLayout } from '../components/console/ConsoleLayout'
import { ConsoleSummaryPanel, type ConsoleSummaryItem } from '../components/console/ConsoleSummaryPanel'
import { PresetCards } from '../components/console/PresetCards'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { usePreprocessingPreset } from '../hooks/usePreprocessingPreset'
import { usePreprocessingPresetDefinitions } from '../hooks/usePreprocessingPresetDefinitions'
import { useUpscaleFactor } from '../hooks/useUpscaleFactor'
import { usePreprocessingFolders } from '../hooks/usePreprocessingFolders'
import { useProductType } from '../hooks/useProductType'
import { usePreprocessingJob } from '../context/PreprocessingJobContext'
import { PREPROCESSING_PRESET_OPTIONS, isPresetModified } from '../constants/preprocessingPresets'
import type { BatchMode } from '../types/batch'
import type { PreprocessOperation, ProductType, UpscaleFactor } from '../types/ipc'
import styles from './Preprocessing.module.css'

// Phase 11.5F — 1× renamed to "None": clearer than a multiplier that reads
// as "do something" when it actually means "skip upscaling entirely". Purely
// a label; the underlying value is still UpscaleFactor's 1 (unchanged CLI
// arg, config, and Python behavior — see upscale.scaleFactor below).
const UPSCALE_OPTIONS: { value: UpscaleFactor; label: string }[] = [
  { value: 1, label: 'None' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
]

// "Product Type" is now presented as a preprocessing Target (Phase 10A) —
// the underlying field/hook/prefs storage stay named objectType/ProductType
// (unchanged backend naming/persistence); this is a UI-only rename. Generic
// is no longer offered here — it remains a Python-side internal fallback
// only, not a user-facing target.
const TARGET_OPTIONS: { value: ProductType; label: string }[] = [
  { value: 'watch',    label: 'Watch' },
  { value: 'ring',     label: 'Ring' },
  { value: 'bracelet', label: 'Bracelet' },
  { value: 'earring',  label: 'Earring' },
]

// Phase 10A — which preprocessing stages to run. Not persisted: every run
// defaults to Both, matching pre-10A behavior. Represented in the UI as one
// Select (so the choice is unambiguous), translated to the underlying
// operations array at the point job.start() is called.
type OperationsChoice = 'both' | 'background_removal' | 'upscale'

const OPERATIONS_OPTIONS: { value: OperationsChoice; label: string }[] = [
  { value: 'both',                label: 'Background Removal + Upscaling' },
  { value: 'background_removal',  label: 'Background Removal Only' },
  { value: 'upscale',             label: 'Upscaling Only' },
]

const OPERATIONS_BY_CHOICE: Record<OperationsChoice, PreprocessOperation[]> = {
  both:                ['background_removal', 'upscale'],
  background_removal:  ['background_removal'],
  upscale:              ['upscale'],
}

const MODE_OPTIONS: { value: BatchMode; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'testing', label: 'Testing' },
]

interface PreprocessingProps {
  // Seeds the optional batch-name field — set when this screen was entered
  // via Home's "Create & Open" with a custom title; empty for sidebar entry.
  initialBatchName?: string
  // Creates the Batch backing this run. Called at Start, before the job
  // spawns, so its id can be forwarded to job.start() — the main process
  // writes that batch's preprocessing-stage status directly as the run
  // progresses.
  onCreateBatch: (sourceDir: string, title: string) => Promise<string>
  // Navigates to the dedicated PreprocessingWorkspace screen once job.start()
  // has actually succeeded (Phase 10F correction — this listing screen never
  // renders the live run inline anymore). Not called on a failed start, so a
  // rejected start (e.g. "already running") leaves the operator on this
  // Configure form with startError visible, rather than stranded on an empty
  // workspace.
  onStarted: () => void
  // Production/Testing (Phase 13E, Decision — "batch name and mode become
  // fields on the consoles themselves"). Controlled from App.tsx's own
  // pendingMode state — createBatch() already reads that same state at
  // creation time, so exposing it here as an editable field required no
  // change to how batch creation actually resolves mode, only where it's
  // set from.
  mode: BatchMode
  onModeChange: (mode: BatchMode) => void
}

// Preprocessing's listing/launcher screen (Phase 10F correction; rebuilt as
// a Console in Phase 13E — two-pane, form left, live summary + Start right).
// It never renders the live run inline — that's PreprocessingWorkspace.tsx's
// job. This keeps "start a batch" and "watch a batch run" as two distinct,
// separately-navigable screens rather than one component silently switching
// modes underneath the user. Its own "Recent Preprocessing Batches" panel
// was absorbed into the Dashboard (Phase 13D) — Home already lists every
// batch, preprocessing ones included, so this screen no longer needs a
// redundant copy of that listing; a compact recent-runs strip was considered
// for this phase too but didn't naturally fit an already-dense two-pane
// layout on top of that (see the Phase 13E report).
export default function Preprocessing({ initialBatchName = '', onCreateBatch, onStarted, mode, onModeChange }: PreprocessingProps) {
  const [batchName, setBatchName] = useState(initialBatchName)
  // Phase 10A — unpersisted by design; always starts back at the default.
  const [opsChoice, setOpsChoice] = useState<OperationsChoice>('both')
  // Bridges the brief async window between clicking Start and navigating to
  // the workspace screen (batch creation + job spawn are both awaited round
  // trips).
  const [starting, setStarting] = useState(false)
  const folders = usePreprocessingFolders()
  // Interpreter status/override UI now lives only in Settings (single source
  // of truth for that control) — this hook is still used here purely for
  // canStart's validity check and to forward an override path to job.start().
  const python  = usePythonInterpreter()
  const upscale = useUpscaleFactor()
  const product = useProductType()
  const preset  = usePreprocessingPreset()
  const job     = usePreprocessingJob()
  // Read-only here — only used to compute each preset card's "Customized"
  // marker (definitions.value !== factory default). Editing definitions
  // remains Settings-only (usePreprocessingPresetDefinitions.saveValues).
  const presetDefinitions = usePreprocessingPresetDefinitions()

  const disabled = starting

  async function pickInputDir(explicitPath?: string) {
    if (disabled) return
    const path = explicitPath ?? await window.api.invoke('dialog:openFolder', { historyKey: 'preprocessing-input' })
    if (path !== null) folders.setInputDir(path)
  }

  async function pickOutputDir(explicitPath?: string) {
    if (disabled) return
    const path = explicitPath ?? await window.api.invoke('dialog:openFolder', { historyKey: 'preprocessing-output' })
    if (path !== null) folders.setOutputDir(path)
  }

  const canStart = (
    folders.inputDir !== '' &&
    folders.outputDir !== '' &&
    python.isValid &&
    !disabled
  )

  async function handleStart() {
    if (!canStart) return
    setStarting(true)
    const batchId = await onCreateBatch(folders.inputDir, batchName)
    const overridePath = python.override.trim()
    const operations = OPERATIONS_BY_CHOICE[opsChoice]
    const started = await job.start({
      inputDir:  folders.inputDir,
      outputDir: folders.outputDir,
      batchId,
      // Upscale Factor is disabled (and moot) when operations excludes
      // upscale — force 1 so the recorded/forwarded value never implies a
      // factor that won't actually run.
      scaleFactor: operations.includes('upscale') ? upscale.scaleFactor : 1,
      objectType: product.productType,
      operations,
      ...(overridePath !== '' ? { pythonPath: overridePath } : {}),
      preset: preset.preset,
    })
    setStarting(false)
    if (started) onStarted()
  }

  const presetCardOptions = PREPROCESSING_PRESET_OPTIONS.map(opt => {
    const definition = presetDefinitions.definitions[opt.value]
    return {
      value: opt.value,
      label: opt.label,
      description: opt.description,
      modified: presetDefinitions.loaded && isPresetModified(opt.value, definition),
      version: definition.version,
    }
  })

  const summaryItems: ConsoleSummaryItem[] = [
    { label: 'Operations', value: OPERATIONS_OPTIONS.find(o => o.value === opsChoice)?.label ?? '' },
    ...(opsChoice !== 'background_removal'
      ? [{ label: 'Upscale Factor', value: UPSCALE_OPTIONS.find(o => o.value === upscale.scaleFactor)?.label ?? '' }]
      : []),
    { label: 'Target', value: TARGET_OPTIONS.find(o => o.value === product.productType)?.label ?? '' },
    { label: 'Preset', value: `${PREPROCESSING_PRESET_OPTIONS.find(o => o.value === preset.preset)?.label ?? ''} v${presetDefinitions.definitions[preset.preset].version}` },
    { label: 'Mode', value: MODE_OPTIONS.find(o => o.value === mode)?.label ?? '' },
  ]

  return (
    <ConsoleLayout
      title="Preprocessing"
      subtitle="Background removal, segmentation, and upscaling for raw imagery."
      summary={
        <ConsoleSummaryPanel
          items={summaryItems}
          onStart={handleStart}
          canStart={canStart}
          starting={starting}
          error={job.startError}
        />
      }
    >
      <div className={styles.nameRow}>
        <div className={styles.selectField}>
          <label className={styles.selectLabel}>Batch Name (optional)</label>
          <input
            className={styles.textInput}
            type="text"
            value={batchName}
            onChange={e => setBatchName(e.target.value)}
            placeholder="A name is generated if left blank"
            spellCheck={false}
            disabled={disabled}
          />
        </div>
        <SegmentedControl label="Mode" options={MODE_OPTIONS} value={mode} onChange={onModeChange} disabled={disabled} />
      </div>

      <PathField
        label="Input Folder"
        value={folders.inputDir}
        placeholder="Select folder containing source images"
        onPick={() => pickInputDir()}
        onDropPath={pickInputDir}
        disabled={disabled}
      />
      <PathField
        label="Output Folder"
        value={folders.outputDir}
        placeholder="Select folder for processed output"
        onPick={() => pickOutputDir()}
        onDropPath={pickOutputDir}
        disabled={disabled}
      />
      <Select
        label="Operations"
        options={OPERATIONS_OPTIONS}
        value={opsChoice}
        onChange={setOpsChoice}
        disabled={disabled}
      />
      <SnapSlider
        label="Upscale Factor"
        options={UPSCALE_OPTIONS}
        value={upscale.scaleFactor}
        onChange={upscale.set}
        disabled={disabled || opsChoice === 'background_removal'}
      />
      {opsChoice === 'upscale' && upscale.scaleFactor === 1 && (
        <p className={styles.helperText}>
          "None" copies images without modification.
        </p>
      )}
      <Select
        label="Target"
        options={TARGET_OPTIONS}
        value={product.productType}
        onChange={product.set}
        disabled={disabled}
      />
      <div className={styles.presetField}>
        <label className={styles.selectLabel}>Preset</label>
        <PresetCards options={presetCardOptions} value={preset.preset} onChange={preset.set} disabled={disabled} />
      </div>
    </ConsoleLayout>
  )
}
