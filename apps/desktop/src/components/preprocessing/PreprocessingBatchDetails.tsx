import { useState } from 'react'
import { usePreprocessingJob } from '../../context/PreprocessingJobContext'
import { PreprocessingSummary } from '../PreprocessingSummary'
import { BatchDetailsSection } from '../batch/BatchDetailsSection'
import { StatusChip } from '../ui/StatusChip'
import { STAGE_LABELS, STAGE_STATUS_LABELS, stageStatusTone } from '../batch/batchDisplay'
import { ThumbnailGrid } from './ThumbnailGrid'
import { ImagePreviewPanel } from './ImagePreviewPanel'
import type { BatchDetailRecord } from '../../types/batch'
import styles from './PreprocessingBatchDetails.module.css'

interface PreprocessingBatchDetailsProps {
  batch: BatchDetailRecord
  inputDir: string
  onReset: () => void
  onContinueToWatchProcessing?: () => Promise<{ ok: boolean; error?: string }>
}

function readConfigValue(config: Record<string, unknown>, key: string): string | null {
  const value = config[key]
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  return String(value)
}

// The first implementation of "Batch Details": the permanent, revisitable
// home for a finished Preprocessing stage. Ships Overview + Images only —
// built as a list of BatchDetailsSections specifically so Logs/QA/Export/
// Analytics/Notes can each arrive later as one more section, with no
// redesign of this page. PreprocessingSummary is reused unchanged for the
// counts/duration/continue/reset controls rather than reimplemented.
export function PreprocessingBatchDetails({
  batch,
  inputDir,
  onReset,
  onContinueToWatchProcessing,
}: PreprocessingBatchDetailsProps) {
  const job = usePreprocessingJob()
  const [selected, setSelected] = useState<string | null>(null)

  const stage = batch.stages.find(s => s.type === 'preprocessing')
  const config = stage?.config ?? {}
  const selectedName = selected ?? job.images[0]?.name ?? null
  const selectedImage = job.images.find(img => img.name === selectedName) ?? null

  const configEntries: [string, string][] = [
    ['Upscale Factor', readConfigValue(config, 'scaleFactor') ? `${readConfigValue(config, 'scaleFactor')}×` : null],
    ['Product Type', readConfigValue(config, 'objectType')],
    ['SAM Points/Side', readConfigValue(config, 'samPointsPerSide')],
    ['SAM Points/Batch', readConfigValue(config, 'samPointsPerBatch')],
    ['SAM Pred IoU', readConfigValue(config, 'samPredIouThresh')],
    ['SAM Stability Score', readConfigValue(config, 'samStabilityScoreThresh')],
    ['SAM Max Masks', readConfigValue(config, 'samMaxMasks')],
  ].filter((entry): entry is [string, string] => entry[1] !== null)

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>{batch.title}</h1>
            <span className={styles.subtitle}>{STAGE_LABELS.preprocessing}</span>
          </div>
          {stage && <StatusChip tone={stageStatusTone(stage.status)}>{STAGE_STATUS_LABELS[stage.status]}</StatusChip>}
        </div>

        <BatchDetailsSection title="Overview">
          {configEntries.length > 0 && (
            <div className={styles.configGrid}>
              {configEntries.map(([label, value]) => (
                <div key={label} className={styles.configRow}>
                  <span className={styles.configLabel}>{label}</span>
                  <span className={styles.configValue}>{value}</span>
                </div>
              ))}
            </div>
          )}
          {stage && (
            <div className={styles.timingRow}>
              {stage.startedAt && <span>Started {new Date(stage.startedAt).toLocaleString()}</span>}
              {stage.completedAt && <span>Finished {new Date(stage.completedAt).toLocaleString()}</span>}
            </div>
          )}
          <div className={styles.summaryWrap}>
            <PreprocessingSummary
              donePayload={job.donePayload}
              fatalError={job.fatalError}
              onReset={onReset}
              onContinueToWatchProcessing={onContinueToWatchProcessing}
            />
          </div>
        </BatchDetailsSection>

        <BatchDetailsSection title="Images">
          <div className={styles.imagesLayout}>
            <div className={styles.gridArea}>
              <ThumbnailGrid
                images={job.images}
                inputDir={inputDir}
                selectedImage={selectedName}
                onSelect={setSelected}
              />
            </div>
            <div className={styles.previewArea}>
              <ImagePreviewPanel image={selectedImage} inputDir={inputDir} mode="details" />
            </div>
          </div>
        </BatchDetailsSection>
      </div>
    </div>
  )
}
