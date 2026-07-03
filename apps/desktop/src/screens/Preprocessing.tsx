import { useState } from 'react'
import { PathField } from '../components/PathField'
import { PythonInterpreterStatus } from '../components/PythonInterpreterStatus'
import { PreprocessingProgress } from '../components/PreprocessingProgress'
import { PreprocessingSummary } from '../components/PreprocessingSummary'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useSamTuning } from '../hooks/useSamTuning'
import { useUpscaleFactor } from '../hooks/useUpscaleFactor'
import type { UpscaleFactor } from '../types/ipc'
import { usePreprocessingJob } from '../context/PreprocessingJobContext'
import { SamTuningPanel } from '../components/SamTuningPanel'
import styles from './Preprocessing.module.css'

export default function Preprocessing() {
  const [inputDir, setInputDir] = useState('')
  const [outputDir, setOutputDir] = useState('')

  const python = usePythonInterpreter()
  const sam = useSamTuning()
  const upscale = useUpscaleFactor()
  const job = usePreprocessingJob()

  async function pickInputDir() {
    const path = await window.api.invoke('dialog:openFolder')
    if (path !== null) setInputDir(path)
  }

  async function pickOutputDir() {
    const path = await window.api.invoke('dialog:openFolder')
    if (path !== null) setOutputDir(path)
  }

  const canStart = inputDir !== '' && outputDir !== '' && python.isValid && job.phase === 'idle'

  async function handleStart() {
    if (!canStart) return
    const overridePath = python.override.trim()
    await job.start({
      inputDir,
      outputDir,
      scaleFactor: upscale.scaleFactor,
      ...(overridePath !== '' ? { pythonPath: overridePath } : {}),
      samPointsPerSide: sam.prefs.pointsPerSide,
      samPointsPerBatch: sam.prefs.pointsPerBatch,
      samPredIouThresh: sam.prefs.predIouThresh,
      samStabilityScoreThresh: sam.prefs.stabilityScoreThresh,
      samMaxMasks: sam.prefs.maxMasks,
      samMultimaskOutput: sam.prefs.multimaskOutput,
    })
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>Preprocessing</h1>

        {job.phase === 'idle' && (
          <>
            <div className={styles.fields}>
              <PathField
                label="Input Folder"
                value={inputDir}
                placeholder="Select folder containing source images"
                onPick={pickInputDir}
              />
              <PathField
                label="Output Folder"
                value={outputDir}
                placeholder="Select folder for processed output"
                onPick={pickOutputDir}
              />
              <div className={styles.selectField}>
                <label className={styles.selectLabel}>Upscale Factor</label>
                <select
                  className={styles.select}
                  value={upscale.scaleFactor}
                  onChange={e => upscale.set(Number(e.target.value) as UpscaleFactor)}
                >
                  <option value={1}>1× (None)</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </div>
              <PythonInterpreterStatus
                resolvedPath={python.resolvedPath}
                resolving={python.resolving}
                override={python.override}
                onOverrideChange={python.setOverride}
              />
              <SamTuningPanel prefs={sam.prefs} onUpdate={sam.update} />
            </div>

            {job.startError && <div className={styles.errorBanner}>{job.startError}</div>}

            <div className={styles.actions}>
              <button className={styles.startButton} onClick={handleStart} disabled={!canStart}>
                Start
              </button>
            </div>
          </>
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
