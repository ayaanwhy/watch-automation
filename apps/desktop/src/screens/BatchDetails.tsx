import { useEffect, useState } from 'react'
import { usePreprocessingJob } from '../context/PreprocessingJobContext'
import { PreprocessingSummary } from '../components/PreprocessingSummary'
import { BatchDetailsSection } from '../components/batch/BatchDetailsSection'
import { StatusChip } from '../components/ui/StatusChip'
import { Button } from '../components/ui/Button'
import { ThumbnailGrid } from '../components/preprocessing/ThumbnailGrid'
import { ImagePreviewPanel } from '../components/preprocessing/ImagePreviewPanel'
import {
  BATCH_STATUS_LABELS,
  STAGE_LABELS,
  STAGE_STATUS_LABELS,
  batchStatusTone,
  stageStatusTone,
  readConfigValue,
} from '../components/batch/batchDisplay'
import { joinPath } from '../lib/paths'
import type { BatchDetailRecord, StageRecord } from '../types/batch'
import type { PreprocessDonePayload } from '../types/ipc'
import type { PreprocessingImageState } from '../context/PreprocessingJobContext'
import type { SessionFile } from '../types/session'
import styles from './BatchDetails.module.css'

interface BatchDetailsProps {
  batchId: string
  onBack: () => void
  // Navigates to a fresh Preprocessing Configure screen, clearing whatever
  // batch App.tsx was tracking — the same semantic "Run another batch" has
  // always had, just reachable from here too now.
  onRunAnotherPreprocessing: () => void
  onContinueToWatchProcessing?: (
    batch: BatchDetailRecord,
    outputDir: string
  ) => Promise<{ ok: boolean; error?: string }>
}

// Builds a PreprocessingSummary-shaped payload purely from a persisted stage
// record — never from PreprocessingJobContext — so the exact same summary
// component renders identically whether this batch just finished in the
// live Preprocessing screen or was reopened from Home in a later session.
function buildDonePayload(stage: StageRecord): PreprocessDonePayload {
  const durationMs =
    stage.startedAt && stage.completedAt
      ? Math.max(0, Date.parse(stage.completedAt) - Date.parse(stage.startedAt))
      : 0
  return {
    jobId: '',
    exitCode: stage.status === 'completed' ? 0 : null,
    succeeded: stage.counts.succeeded,
    failed: stage.counts.failed,
    totalDurationMs: durationMs,
    cancelledByUser: stage.status === 'cancelled',
  }
}

function latestCompletedAt(stages: StageRecord[]): string | null {
  const timestamps = stages.map(s => s.completedAt).filter((t): t is string => t !== null)
  if (timestamps.length === 0) return null
  return timestamps.reduce((latest, t) => (Date.parse(t) > Date.parse(latest) ? t : latest))
}

const PREPROCESSING_CONFIG_FIELDS: [string, string, string | undefined][] = [
  ['scaleFactor', 'Upscale Factor', '×'],
  ['objectType', 'Product Type', undefined],
  ['samPointsPerSide', 'SAM Points/Side', undefined],
  ['samPointsPerBatch', 'SAM Points/Batch', undefined],
  ['samPredIouThresh', 'SAM Pred IoU', undefined],
  ['samStabilityScoreThresh', 'SAM Stability Score', undefined],
  ['samMaxMasks', 'SAM Max Masks', undefined],
]

const WATCH_CONFIG_FIELDS: [string, string, string | undefined][] = [
  ['spreadsheetPath', 'Spreadsheet', undefined],
]

function ConfigGrid({
  config,
  fields,
}: {
  config: Record<string, unknown>
  fields: [string, string, string | undefined][]
}) {
  const entries: { label: string; value: string; suffix: string }[] = []
  for (const [key, label, suffix] of fields) {
    const value = readConfigValue(config, key)
    if (value !== null) entries.push({ label, value, suffix: suffix ?? '' })
  }
  if (entries.length === 0) return null
  return (
    <div className={styles.configGrid}>
      {entries.map(e => (
        <div key={e.label} className={styles.configRow}>
          <span className={styles.configLabel}>{e.label}</span>
          <span className={styles.configValue}>{e.value}{e.suffix}</span>
        </div>
      ))}
    </div>
  )
}

function StageTiming({ stage }: { stage: StageRecord }) {
  if (!stage.startedAt && !stage.completedAt) return null
  return (
    <div className={styles.timingRow}>
      {stage.startedAt && <span>Started {new Date(stage.startedAt).toLocaleString()}</span>}
      {stage.completedAt && <span>Finished {new Date(stage.completedAt).toLocaleString()}</span>}
    </div>
  )
}

// The permanent, revisitable "project page" for a Batch (Phase 9E). Always
// sources its content from the registry (via batchId), never from
// PreprocessingJobContext — the same rendering serves a batch that just
// finished in the live Preprocessing screen and one reopened from Home in a
// later session. Ships Overview + Images only; both are BatchDetailsSections
// (from 9D) so Logs/QA/Export/Analytics/Notes can each arrive later as one
// more section, with no redesign of this page.
export default function BatchDetails({
  batchId,
  onBack,
  onRunAnotherPreprocessing,
  onContinueToWatchProcessing,
}: BatchDetailsProps) {
  const job = usePreprocessingJob()
  const [batch, setBatch] = useState<BatchDetailRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [selectedImage, setSelectedImage] = useState<string | null>(null)

  // Watch stages have no meaningful counts/images of their own in the
  // registry (Watch's live progress is tracked in QueueContext/AnnotationContext,
  // never synced back to the batch) — per the explicit design for this
  // phase, Watch's Overview/Images are derived by loading its own SessionFile
  // through the existing session:load channel, reusing the stage's already-
  // stored inputDir/outputDir/spreadsheetPath as the session reference,
  // rather than copying annotation data into the batch registry.
  const [watchSession, setWatchSession] = useState<SessionFile | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.api.invoke('batch-registry:get', { id: batchId }).then(detail => {
      if (cancelled) return
      setBatch(detail)
      setTitleDraft(detail?.title ?? '')
      setSelectedImage(null)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [batchId])

  const watchStage = batch?.stages.find(s => s.type === 'watch')
  const watchSpreadsheetPath =
    watchStage && typeof watchStage.config.spreadsheetPath === 'string' ? watchStage.config.spreadsheetPath : null

  useEffect(() => {
    if (!watchStage || watchStage.status === 'not_started' || !watchStage.outputDir || !watchSpreadsheetPath) {
      setWatchSession(null)
      return
    }
    let cancelled = false
    void window.api
      .invoke('session:load', {
        inputFolder: watchStage.inputDir,
        outputFolder: watchStage.outputDir,
        spreadsheetPath: watchSpreadsheetPath,
      })
      .then(result => {
        if (cancelled) return
        setWatchSession(result.ok ? result.session : null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchStage?.inputDir, watchStage?.outputDir, watchStage?.status, watchSpreadsheetPath])

  async function handleSaveTitle() {
    const title = titleDraft.trim()
    if (!batch || !title || title === batch.title) {
      setEditingTitle(false)
      setTitleDraft(batch?.title ?? '')
      return
    }
    const updated = await window.api.invoke('batch-registry:rename', { id: batch.id, title })
    if (updated) setBatch(updated)
    setEditingTitle(false)
  }

  function handleRunAnother() {
    job.reset()
    onRunAnotherPreprocessing()
  }

  function handleContinue(outputDir: string) {
    if (!batch || !onContinueToWatchProcessing) return Promise.resolve({ ok: false })
    return onContinueToWatchProcessing(batch, outputDir)
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading batch…</div>
        </div>
      </div>
    )
  }

  if (!batch) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.loading}>Batch not found.</div>
          <Button variant="ghost" onClick={onBack}>← Home</Button>
        </div>
      </div>
    )
  }

  const preprocessingStage = batch.stages.find(s => s.type === 'preprocessing')
  const completedAt = latestCompletedAt(batch.stages)

  // Unified Images data — whichever stage has actually produced something,
  // preferring Watch's since it represents the batch's most advanced state
  // when a pipeline has run through both. Preprocessing hasn't run or its
  // outputs don't exist yet → this simply stays empty; ThumbnailGrid and
  // ImagePreviewPanel already degrade to their own empty states for that.
  let imageInputDir = ''
  let images: PreprocessingImageState[] = []
  if (watchStage && watchStage.status !== 'not_started' && watchSession) {
    imageInputDir = watchStage.inputDir
    const queueBySku = new Map(watchSession.processingQueue.map(q => [q.sku, q]))
    images = watchSession.annotations.map(a => {
      const q = queueBySku.get(a.sku)
      const status: PreprocessingImageState['status'] =
        q?.status === 'complete' ? 'completed' : q?.status === 'failed' ? 'failed' : 'pending'
      return {
        name: `${a.sku}.png`,
        status,
        stage: null,
        outputPath:
          status === 'completed' && watchStage.outputDir
            ? joinPath(watchStage.outputDir, `${a.sku};frontImage.png`)
            : null,
        error: q?.error ?? null,
        durationMs: null,
      }
    })
  } else if (preprocessingStage && preprocessingStage.images.length > 0) {
    imageInputDir = preprocessingStage.inputDir
    images = preprocessingStage.images.map(img => ({
      name: img.name,
      status: img.status,
      stage: null,
      outputPath: img.outputPath,
      error: img.error,
      durationMs: img.durationMs,
    }))
  }
  const selectedImageState = images.find(img => img.name === selectedImage) ?? images[0] ?? null

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <button className={styles.backLink} onClick={onBack}>← Home</button>

        <div className={styles.header}>
          {editingTitle ? (
            <div className={styles.editRow}>
              <input
                className={styles.editInput}
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleSaveTitle()
                  if (e.key === 'Escape') {
                    setEditingTitle(false)
                    setTitleDraft(batch.title)
                  }
                }}
                autoFocus
                spellCheck={false}
              />
              <Button size="sm" variant="ghost" onClick={handleSaveTitle}>Save</Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingTitle(false)
                  setTitleDraft(batch.title)
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className={styles.titleGroup}>
              <h1 className={styles.title}>{batch.title}</h1>
              <button
                className={styles.editButton}
                onClick={() => setEditingTitle(true)}
                aria-label="Rename batch"
                title="Rename"
              >
                ✎
              </button>
            </div>
          )}
          <StatusChip tone={batchStatusTone(batch.status)}>{BATCH_STATUS_LABELS[batch.status]}</StatusChip>
        </div>

        <BatchDetailsSection title="Overview">
          <div className={styles.metaRow}>
            <span>Created {new Date(batch.createdAt).toLocaleString()}</span>
            {completedAt && <span>Completed {new Date(completedAt).toLocaleString()}</span>}
            <span>Duration {batch.durationMs !== null ? formatDurationLong(batch.durationMs) : '—'}</span>
          </div>

          <div className={styles.pipelineRow}>
            {batch.pipeline.map(type => {
              const stage = batch.stages.find(s => s.type === type)
              return (
                <span key={type} className={styles.pipelineChip}>
                  <StatusChip tone={stageStatusTone(stage?.status ?? 'not_started')}>
                    {STAGE_LABELS[type]}
                  </StatusChip>
                </span>
              )
            })}
          </div>

          {preprocessingStage && preprocessingStage.status !== 'not_started' && (
            <div className={styles.stageBlock}>
              <div className={styles.stageHeader}>
                <span className={styles.stageName}>{STAGE_LABELS.preprocessing}</span>
                <StatusChip tone={stageStatusTone(preprocessingStage.status)}>
                  {STAGE_STATUS_LABELS[preprocessingStage.status]}
                </StatusChip>
              </div>
              <ConfigGrid config={preprocessingStage.config} fields={PREPROCESSING_CONFIG_FIELDS} />
              <StageTiming stage={preprocessingStage} />
              <div className={styles.summaryWrap}>
                <PreprocessingSummary
                  donePayload={buildDonePayload(preprocessingStage)}
                  fatalError={preprocessingStage.status === 'failed' ? preprocessingStage.error : null}
                  onReset={handleRunAnother}
                  onContinueToWatchProcessing={
                    onContinueToWatchProcessing && batch.currentStage === 'watch'
                      ? () => handleContinue(preprocessingStage.outputDir ?? '')
                      : undefined
                  }
                />
              </div>
            </div>
          )}

          {watchStage && watchStage.status !== 'not_started' && (
            <div className={styles.stageBlock}>
              <div className={styles.stageHeader}>
                <span className={styles.stageName}>{STAGE_LABELS.watch}</span>
                <StatusChip tone={stageStatusTone(watchStage.status)}>
                  {STAGE_STATUS_LABELS[watchStage.status]}
                </StatusChip>
              </div>
              <ConfigGrid config={watchStage.config} fields={WATCH_CONFIG_FIELDS} />
              <StageTiming stage={watchStage} />
              {watchSession ? (
                <div className={styles.metaRow}>
                  <span>{watchSession.annotations.length} matched</span>
                  <span>
                    {watchSession.annotations.filter(a => a.status === 'annotated').length} annotated
                  </span>
                  <span>
                    {watchSession.processingQueue.filter(q => q.status === 'complete').length} exported
                  </span>
                  {watchSession.processingQueue.some(q => q.status === 'failed') && (
                    <span>{watchSession.processingQueue.filter(q => q.status === 'failed').length} failed</span>
                  )}
                </div>
              ) : (
                <div className={styles.metaRow}>
                  <span>Session details unavailable.</span>
                </div>
              )}
            </div>
          )}
        </BatchDetailsSection>

        <BatchDetailsSection title="Images">
          <div className={styles.imagesLayout}>
            <div className={styles.gridArea}>
              <ThumbnailGrid
                images={images}
                inputDir={imageInputDir}
                selectedImage={selectedImageState?.name ?? null}
                onSelect={setSelectedImage}
              />
            </div>
            <div className={styles.previewArea}>
              <ImagePreviewPanel image={selectedImageState} inputDir={imageInputDir} mode="details" />
            </div>
          </div>
        </BatchDetailsSection>
      </div>
    </div>
  )
}

function formatDurationLong(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}
