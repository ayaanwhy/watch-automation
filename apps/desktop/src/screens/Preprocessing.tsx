import { useState } from 'react'
import { PathField } from '../components/PathField'
import { SnapSlider } from '../components/SnapSlider'
import { Select } from '../components/ui/Select'
import { PreprocessingRunWorkspace } from '../components/preprocessing/PreprocessingRunWorkspace'
import { findStageStatus } from '../components/batch/batchDisplay'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useSamTuning } from '../hooks/useSamTuning'
import { useUpscaleFactor } from '../hooks/useUpscaleFactor'
import { usePreprocessingFolders } from '../hooks/usePreprocessingFolders'
import { useProductType } from '../hooks/useProductType'
import { usePreprocessingJob } from '../context/PreprocessingJobContext'
import type { BatchDetailRecord } from '../types/batch'
import type { PreprocessOperation, ProductType, UpscaleFactor } from '../types/ipc'
import styles from './Preprocessing.module.css'

const UPSCALE_OPTIONS: { value: UpscaleFactor; label: string }[] = [
  { value: 1, label: '1×' },
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
  // The batch backing the current/most recent run, or null before one
  // exists. Used only to decide Configure vs. Run here — a terminal status
  // is handled one level up in App.tsx, which renders the canonical
  // BatchDetails screen instead (Phase 9E; the same screen a batch reopened
  // from Home uses), so this component never needs to render that itself.
  batch: BatchDetailRecord | null
  // Seeds the optional batch-name field — set when this screen was entered
  // via Home's "Create & Open" with a custom title; empty for sidebar entry.
  initialBatchName?: string
  // Creates (or resolves, when continuing an existing batch) the Batch
  // backing this run. Called at Start, before the job spawns, so its id can
  // be forwarded to job.start() — the main process writes that batch's
  // preprocessing-stage status directly as the run progresses.
  onCreateBatch: (sourceDir: string, title: string) => Promise<string>
}

export default function Preprocessing({ batch, initialBatchName = '', onCreateBatch }: PreprocessingProps) {
  const [batchName, setBatchName] = useState(initialBatchName)
  // Phase 10A — unpersisted by design; always starts back at the default.
  const [opsChoice, setOpsChoice] = useState<OperationsChoice>('both')
  // Bridges the brief async window between clicking Start and the batch's
  // status actually flipping to 'running' (batch creation + job spawn are
  // both awaited round trips) — Configure has no other reason to disable
  // once a batch is genuinely running, since Run takes over entirely then.
  const [starting, setStarting] = useState(false)
  const folders = usePreprocessingFolders()
  // Interpreter status/override UI now lives only in Settings (single source
  // of truth for that control) — this hook is still used here purely for
  // canStart's validity check and to forward an override path to job.start().
  const python  = usePythonInterpreter()
  const upscale = useUpscaleFactor()
  const product = useProductType()
  const sam     = useSamTuning()
  const job     = usePreprocessingJob()

  const stageStatus = findStageStatus(batch, 'preprocessing')
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
    await job.start({
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
      samPointsPerSide:         sam.prefs.pointsPerSide,
      samPointsPerBatch:        sam.prefs.pointsPerBatch,
      samPredIouThresh:         sam.prefs.predIouThresh,
      samStabilityScoreThresh:  sam.prefs.stabilityScoreThresh,
      samMaxMasks:              sam.prefs.maxMasks,
      samMultimaskOutput:       sam.prefs.multimaskOutput,
    })
    setStarting(false)
  }

  if (stageStatus === 'running') {
    const stage = batch?.stages.find(s => s.type === 'preprocessing')
    return <PreprocessingRunWorkspace inputDir={stage?.inputDir || folders.inputDir} />
  }

  // ── Configure ────────────────────────────────────────────────────────────
  // (App.tsx never renders this component for a terminal batch status, so
  // stageStatus here is always 'none' | 'not_started' | 'configuring'.)
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
              1× upscaling copies images without modification.
            </p>
          )}
          <Select
            label="Target"
            options={TARGET_OPTIONS}
            value={product.productType}
            onChange={product.set}
            disabled={disabled}
          />
        </div>

        {job.startError && (
          <div className={styles.errorBanner}>{job.startError}</div>
        )}

        <div className={styles.actions}>
          <button className={styles.startButton} onClick={handleStart} disabled={!canStart}>
            {starting ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  )
}
