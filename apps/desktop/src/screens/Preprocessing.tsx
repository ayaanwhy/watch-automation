import { useState } from 'react'
import { PathField } from '../components/PathField'
import { PythonInterpreterStatus } from '../components/PythonInterpreterStatus'
import { SnapSlider } from '../components/SnapSlider'
import { PreprocessingRunWorkspace } from '../components/preprocessing/PreprocessingRunWorkspace'
import { findStageStatus } from '../components/batch/batchDisplay'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useSamTuning } from '../hooks/useSamTuning'
import { useUpscaleFactor } from '../hooks/useUpscaleFactor'
import { usePreprocessingFolders } from '../hooks/usePreprocessingFolders'
import { useProductType } from '../hooks/useProductType'
import { usePreprocessingJob } from '../context/PreprocessingJobContext'
import type { BatchDetailRecord } from '../types/batch'
import type { ProductType, UpscaleFactor } from '../types/ipc'
import styles from './Preprocessing.module.css'

const UPSCALE_OPTIONS: { value: UpscaleFactor; label: string }[] = [
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
]

const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = [
  { value: 'watch',    label: 'Watch' },
  { value: 'bracelet', label: 'Bracelet' },
  { value: 'ring',     label: 'Ring' },
  { value: 'generic',  label: 'Generic' },
]

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
  // Bridges the brief async window between clicking Start and the batch's
  // status actually flipping to 'running' (batch creation + job spawn are
  // both awaited round trips) — Configure has no other reason to disable
  // once a batch is genuinely running, since Run takes over entirely then.
  const [starting, setStarting] = useState(false)
  const folders = usePreprocessingFolders()
  const python  = usePythonInterpreter()
  const upscale = useUpscaleFactor()
  const product = useProductType()
  const sam     = useSamTuning()
  const job     = usePreprocessingJob()

  const stageStatus = findStageStatus(batch, 'preprocessing')
  const disabled = starting

  async function pickInputDir() {
    if (disabled) return
    const path = await window.api.invoke('dialog:openFolder')
    if (path !== null) folders.setInputDir(path)
  }

  async function pickOutputDir() {
    if (disabled) return
    const path = await window.api.invoke('dialog:openFolder')
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
    await job.start({
      inputDir:  folders.inputDir,
      outputDir: folders.outputDir,
      batchId,
      scaleFactor: upscale.scaleFactor,
      objectType: product.productType,
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
            onPick={pickInputDir}
            disabled={disabled}
          />
          <PathField
            label="Output Folder"
            value={folders.outputDir}
            placeholder="Select folder for processed output"
            onPick={pickOutputDir}
            disabled={disabled}
          />
          <SnapSlider
            label="Upscale Factor"
            options={UPSCALE_OPTIONS}
            value={upscale.scaleFactor}
            onChange={upscale.set}
            disabled={disabled}
          />
          <div className={styles.selectField}>
            <label className={styles.selectLabel}>Product Type</label>
            <select
              className={styles.select}
              value={product.productType}
              onChange={e => product.set(e.target.value as ProductType)}
              disabled={disabled}
            >
              {PRODUCT_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <PythonInterpreterStatus
            resolvedPath={python.resolvedPath}
            resolving={python.resolving}
            override={python.override}
            onOverrideChange={python.setOverride}
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
