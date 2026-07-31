import { useEffect, useState } from 'react'
import { PathField } from '../components/PathField'
import { SnapSlider } from '../components/SnapSlider'
import { Select } from '../components/ui/Select'
import { BatchCard } from '../components/batch/BatchCard'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { usePreprocessingPreset } from '../hooks/usePreprocessingPreset'
import { useUpscaleFactor } from '../hooks/useUpscaleFactor'
import { usePreprocessingFolders } from '../hooks/usePreprocessingFolders'
import { useProductType } from '../hooks/useProductType'
import { usePreprocessingJob } from '../context/PreprocessingJobContext'
import { PREPROCESSING_PRESET_OPTIONS } from '../constants/preprocessingPresets'
import type { BatchSummaryRecord } from '../types/batch'
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

interface PreprocessingProps {
  // Seeds the optional batch-name field — set when this screen was entered
  // via Home's "Create & Open" with a custom title; empty for sidebar entry.
  initialBatchName?: string
  // Creates the Batch backing this run. Called at Start, before the job
  // spawns, so its id can be forwarded to job.start() — the main process
  // writes that batch's preprocessing-stage status directly as the run
  // progresses.
  onCreateBatch: (sourceDir: string, title: string) => Promise<string>
  // Reopens a batch from the "Recent Preprocessing Batches" panel — the same
  // handler Home's own batch list uses, so a running batch opens the
  // dedicated workspace and a terminal one opens Batch Details, identically
  // regardless of which screen it was opened from.
  onOpenBatch: (id: string) => void
  // Navigates to the dedicated PreprocessingWorkspace screen once job.start()
  // has actually succeeded (Phase 10F correction — this listing screen never
  // renders the live run inline anymore). Not called on a failed start, so a
  // rejected start (e.g. "already running") leaves the operator on this
  // Configure form with startError visible, rather than stranded on an empty
  // workspace.
  onStarted: () => void
}

// Preprocessing's listing/launcher screen (Phase 10F correction): Configure
// form + recent-batch history, always. It never renders the live run
// inline — that's PreprocessingWorkspace.tsx's job. This keeps "start a
// batch" and "watch a batch run" as two distinct, separately-navigable
// screens rather than one component silently switching modes underneath
// the user, which was the previous (undesired) behavior.
export default function Preprocessing({ initialBatchName = '', onCreateBatch, onOpenBatch, onStarted }: PreprocessingProps) {
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

  const disabled = starting

  // "Recent Preprocessing Batches" — running and completed batches stay
  // visible/reopenable from this listing. Fetched once on mount; this
  // component remounts fresh every time navigation returns to 'preprocessing'
  // (App.tsx only renders it for that view), so a plain mount-time fetch is
  // enough to always reflect current state — no live subscription needed.
  const [recentBatches, setRecentBatches] = useState<BatchSummaryRecord[]>([])

  useEffect(() => {
    void window.api.invoke('batch-registry:list').then(list =>
      setRecentBatches(list.filter(b => b.pipeline.includes('preprocessing')))
    )
  }, [])

  function handleRecentRenamed(updated: BatchSummaryRecord) {
    setRecentBatches(prev => prev.map(b => (b.id === updated.id ? updated : b)))
  }

  function handleRecentDeleted(id: string) {
    setRecentBatches(prev => prev.filter(b => b.id !== id))
  }

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

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Preprocessing</h1>
        </div>

        {/* Configuration — always visible; controls disabled while a run is starting */}
        <div className={styles.fields}>
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
          <Select
            label="Preset"
            options={PREPROCESSING_PRESET_OPTIONS}
            value={preset.preset}
            onChange={preset.set}
            disabled={disabled}
          />
          <p className={styles.helperText}>
            {PREPROCESSING_PRESET_OPTIONS.find(o => o.value === preset.preset)?.description}
          </p>
        </div>

        {job.startError && (
          <div className={styles.errorBanner}>{job.startError}</div>
        )}

        <div className={styles.actions}>
          <button className={styles.startButton} onClick={handleStart} disabled={!canStart}>
            {starting ? 'Starting…' : 'Start'}
          </button>
        </div>

        {recentBatches.length > 0 && (
          <div className={styles.recentPanel}>
            <div className={styles.recentHeading}>Recent Preprocessing Batches</div>
            <div className={styles.recentList}>
              {recentBatches.map(b => (
                <BatchCard
                  key={b.id}
                  batch={b}
                  onOpen={() => onOpenBatch(b.id)}
                  onRenamed={handleRecentRenamed}
                  onDeleted={handleRecentDeleted}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
