import { PathField } from '../components/PathField'
import { PythonInterpreterStatus } from '../components/PythonInterpreterStatus'
import { PreprocessingProgress } from '../components/PreprocessingProgress'
import { PreprocessingSummary } from '../components/PreprocessingSummary'
import { SnapSlider } from '../components/SnapSlider'
import { SamTuningPanel } from '../components/SamTuningPanel'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useSamTuning } from '../hooks/useSamTuning'
import { useUpscaleFactor } from '../hooks/useUpscaleFactor'
import { usePreprocessingFolders } from '../hooks/usePreprocessingFolders'
import { useProductType } from '../hooks/useProductType'
import { usePreprocessingJob } from '../context/PreprocessingJobContext'
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

export default function Preprocessing() {
  const folders = usePreprocessingFolders()
  const python  = usePythonInterpreter()
  const upscale = useUpscaleFactor()
  const product = useProductType()
  const sam     = useSamTuning()
  const job     = usePreprocessingJob()

  const isIdle   = job.phase === 'idle'
  const disabled = !isIdle

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
    isIdle
  )

  async function handleStart() {
    if (!canStart) return
    const overridePath = python.override.trim()
    await job.start({
      inputDir:  folders.inputDir,
      outputDir: folders.outputDir,
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
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>Preprocessing</h1>

        {/* Configuration — always visible; controls disabled while a job runs */}
        <div className={styles.fields}>
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
          <SamTuningPanel
            prefs={sam.prefs}
            onUpdate={sam.update}
            disabled={disabled}
          />
        </div>

        {/* Error banner — only relevant when idle */}
        {isIdle && job.startError && (
          <div className={styles.errorBanner}>{job.startError}</div>
        )}

        {/* Phase-specific content below the config */}
        {isIdle && (
          <div className={styles.actions}>
            <button className={styles.startButton} onClick={handleStart} disabled={!canStart}>
              Start
            </button>
          </div>
        )}

        {job.phase === 'running' && (
          <PreprocessingProgress
            progress={job.progress}
            cancelPhase={job.cancelPhase}
            startedAt={job.startedAt}
            onCancel={job.cancel}
          />
        )}

        {job.phase === 'done' && (
          <PreprocessingSummary
            donePayload={job.donePayload}
            fatalError={job.fatalError}
            onReset={job.reset}
          />
        )}
      </div>
    </div>
  )
}
