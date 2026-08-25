import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Pencil, Check, X, Flag, FolderX } from 'lucide-react'
import { useRingBraceletJob } from '../context/RingBraceletJobContext'
import { useEarringJob } from '../context/EarringJobContext'
import { PreprocessingSummary } from '../components/PreprocessingSummary'
import type { EditingHandoffOptions } from '../components/preprocessing/EditingHandoffDialog'
import { BatchDetailsSection } from '../components/batch/BatchDetailsSection'
import { EmptyState } from '../components/ui/EmptyState'
import { ReviewToolbar } from '../components/batch/ReviewToolbar'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { ThumbnailGrid, findAdjacentImage } from '../components/shared/ThumbnailGrid'
import { ImagePreviewPanel } from '../components/preprocessing/ImagePreviewPanel'
import { RingBraceletImagePreviewPanel, EARRING_PREVIEW_OVERRIDES } from '../components/ringBracelet/RingBraceletImagePreviewPanel'
import { FullscreenViewer } from '../components/ui/FullscreenViewer'
import type { ComparisonBackground, CompareMode } from '../components/shared/BeforeAfterSlider'
import {
  BATCH_STATUS_LABELS,
  STAGE_LABELS,
  STAGE_STATUS_LABELS,
  batchStatusTone,
  stageStatusTone,
  readConfigValue,
} from '../components/batch/batchDisplay'
import { joinPath } from '../lib/paths'
import { formatProcessingMode } from '../constants/processingMode'
import type { BatchDetailRecord, BatchMode, StageRecord } from '../types/batch'
import type { PreprocessDonePayload } from '../types/ipc'
import type { PreprocessingImageState } from '../context/PreprocessingJobContext'
import type { RingBraceletImageState } from '../context/RingBraceletJobContext'
import type { SessionFile } from '../types/session'
import styles from './BatchDetails.module.css'

interface BatchDetailsProps {
  batchId: string
  onBack: () => void
  // Generalized (Phase 10F) from the original Watch-only "Continue to Watch
  // Processing" — options are collected by EditingHandoffDialog before this
  // is called (see PreprocessingSummary).
  onEditingHandoff?: (
    batch: BatchDetailRecord,
    outputDir: string,
    options: EditingHandoffOptions
  ) => Promise<{ ok: boolean; error?: string }>
  // Ring & Bracelet & Earring (Phase 10D, extended in 12C) — same "run
  // another" semantic, returning to the shared Editing setup screen with the
  // same product preselected.
  onRunAnotherEditing: (product: 'ring' | 'bracelet' | 'earring') => void
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

// Phase 10A — "objectType" is presented as "Target" here purely as a label;
// the underlying config key/persistence stays objectType, unchanged.
const PREPROCESSING_CONFIG_FIELDS: [string, string, string | undefined][] = [
  ['scaleFactor', 'Upscale Factor', '×'],
  ['objectType', 'Target', undefined],
  ['operations', 'Operations', undefined],
  ['preset', 'Preset', undefined],
]

// Phase 10A — operations is stored as an array (['background_removal', 'upscale']);
// a plain String(value) would render it as a comma-joined raw string, so it
// gets a small dedicated label instead of the generic readConfigValue path.
const OPERATION_LABELS: Record<string, string> = {
  background_removal: 'Background Removal',
  upscale: 'Upscaling',
}

function formatOperations(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null
  return value.map(op => OPERATION_LABELS[op as string] ?? String(op)).join(' + ')
}

// Phase 11.5B — preset is stored as its lowercase name ('fast' | 'balanced' |
// 'quality'); displayed capitalized to match the Preprocessing screen's Select.
const PRESET_LABELS: Record<string, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  quality: 'Quality',
}

// 11.5B follow-up — presetVersion records which revision of the preset's
// (now user-editable) definition was active when the batch ran. Older
// batches predate this field and simply omit it, so the version suffix is
// only appended when present.
function formatPreset(value: unknown, version: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  const label = PRESET_LABELS[value] ?? value
  return typeof version === 'number' ? `${label} (v${version})` : label
}

const WATCH_CONFIG_FIELDS: [string, string, string | undefined][] = [
  ['spreadsheetPath', 'Spreadsheet', undefined],
  ['processingMode', 'Mode', undefined],
]

// Phase 10D — "product" here is 'ring' | 'bracelet' | 'earring'; "splitY" is
// the fallback vertical split used when no hole topology is found (see
// shank_mask.py), Ring & Bracelet only. "metadataPath" (Phase 12F) is
// Earring only — the product-metadata sheet earringHandlers.ts's
// buildStageConfig records under that key; readConfigValue already skips a
// field a given product's config doesn't have, so Ring/Bracelet batches
// simply never show this row, same as Earring never shows Fallback Split.
const EDITING_CONFIG_FIELDS: [string, string, string | undefined][] = [
  ['product', 'Product', undefined],
  ['splitY', 'Fallback Split', undefined],
  ['metadataPath', 'Metadata Sheet', undefined],
  ['processingMode', 'Mode', undefined],
]

// Testing/Production is editable after creation (Phase 10F correction) —
// same options shape as Home's filter and EditingSetup's Mode field.
const MODE_OPTIONS: { value: BatchMode; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'testing', label: 'Testing' },
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
    const value =
      key === 'operations'     ? formatOperations(config[key]) :
      key === 'preset'         ? formatPreset(config[key], config['presetVersion']) :
      key === 'processingMode' ? formatProcessingMode(config[key]) :
      readConfigValue(config, key)
    if (value === null) continue
    // Phase 11.5F — matches the Preprocessing screen's 1×→"None" rename;
    // the suffix ('×') only makes sense once upscaling actually happened.
    if (key === 'scaleFactor' && value === '1') {
      entries.push({ label, value: 'None', suffix: '' })
    } else {
      entries.push({ label, value, suffix: suffix ?? '' })
    }
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
  onEditingHandoff,
  onRunAnotherEditing,
}: BatchDetailsProps) {
  const ringBraceletJob = useRingBraceletJob()
  const earringJob = useEarringJob()
  const [batch, setBatch] = useState<BatchDetailRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  // Review toolbar (Phase 13G) — lifted above the grid/preview split so the
  // same backdrop/compare/zoom choice applies regardless of which image is
  // selected or whether the viewer is fullscreen; passed down as controlled
  // props to whichever preview panel is currently mounted.
  const [reviewBackground, setReviewBackground] = useState<ComparisonBackground>('transparent')
  const [reviewCompareMode, setReviewCompareMode] = useState<CompareMode>('slider')
  const [reviewZoom, setReviewZoom] = useState(1)

  // Keyboard QA loop (Phase 13G) — arrows traverse the grid, F toggles Needs
  // Fixing, Enter opens fullscreen (B is already handled inside whichever
  // preview panel is mounted, via useBackdropCycle — nothing to add here).
  // Subscribed once (stable empty deps) and reads everything it needs from
  // this ref, which is refreshed every render below (after the early
  // returns, once batch/selection data actually exists) — avoids both the
  // "hooks after an early return" violation and stale closures over `batch`.
  const qaContextRef = useRef<{
    editingTitle: boolean
    fullscreen: boolean
    activeList: { name: string }[]
    activeName: string | null
    canToggleNeedsFixing: boolean
    toggleNeedsFixing: () => void
    openFullscreen: () => void
    selectImage: (name: string) => void
  } | null>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const ctx = qaContextRef.current
      if (!ctx || ctx.editingTitle) return
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return

      if (e.key === 'ArrowLeft' && !ctx.fullscreen) {
        const prev = findAdjacentImage(ctx.activeList, ctx.activeName, -1)
        if (prev) ctx.selectImage(prev)
      } else if (e.key === 'ArrowRight' && !ctx.fullscreen) {
        const next = findAdjacentImage(ctx.activeList, ctx.activeName, 1)
        if (next) ctx.selectImage(next)
      } else if (e.key === 'Enter' && !ctx.fullscreen) {
        ctx.openFullscreen()
      } else if (e.key.toLowerCase() === 'f' && ctx.canToggleNeedsFixing) {
        e.preventDefault()
        ctx.toggleNeedsFixing()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

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

  // Testing/Production is editable after creation (Phase 10F correction) —
  // persists immediately; Home's own filter reflects it the next time Home
  // fetches the batch list (it always fetches fresh on mount, so no separate
  // live-sync push is needed between the two screens).
  async function handleSetMode(mode: BatchMode) {
    if (!batch) return
    const updated = await window.api.invoke('batch-registry:set-mode', { id: batch.id, mode })
    if (updated) setBatch(updated)
  }

  // Manual QA review (Phase 11.5E) — scoped to the editing stage for this
  // phase (see IMPLEMENTATION_PLAN.md). Persists immediately; the returned
  // batch already has counts.needsFixing/succeeded recomputed, so no
  // separate refetch is needed.
  async function handleToggleNeedsFixing(imageName: string, next: boolean) {
    if (!batch) return
    const updated = await window.api.invoke('batch-registry:set-image-needs-fixing', {
      id: batch.id,
      stageType: 'editing',
      imageName,
      needsFixing: next,
    })
    if (updated) setBatch(updated)
  }

  function handleRunAnotherEditing(product: 'ring' | 'bracelet' | 'earring') {
    if (product === 'earring') {
      earringJob.reset()
    } else {
      ringBraceletJob.reset()
    }
    onRunAnotherEditing(product)
  }

  function handleEditingHandoff(outputDir: string, options: EditingHandoffOptions) {
    if (!batch || !onEditingHandoff) return Promise.resolve({ ok: false })
    return onEditingHandoff(batch, outputDir, options)
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
          <EmptyState icon={FolderX} message="Batch not found." actionLabel="Back to Dashboard" onAction={onBack} />
        </div>
      </div>
    )
  }

  const preprocessingStage = batch.stages.find(s => s.type === 'preprocessing')
  const editingStage = batch.stages.find(s => s.type === 'editing')
  const editingProduct: 'ring' | 'bracelet' | 'earring' =
    editingStage?.config.product === 'bracelet'
      ? 'bracelet'
      : editingStage?.config.product === 'earring'
        ? 'earring'
        : 'ring'
  const completedAt = latestCompletedAt(batch.stages)

  // Unified Images data — whichever stage has actually produced something,
  // preferring Watch's since it represents the batch's most advanced state
  // when a pipeline has run through both. Preprocessing hasn't run or its
  // outputs don't exist yet → this simply stays empty; ThumbnailGrid and
  // ImagePreviewPanel already degrade to their own empty states for that.
  // Ring & Bracelet (Phase 10D) is mutually exclusive with Watch/Preprocessing
  // — its pipeline is always ['editing'] alone — so it's a separate variable
  // rather than a third case shoehorned into PreprocessingImageState's
  // single-outputPath shape.
  let imageInputDir = ''
  let images: PreprocessingImageState[] = []
  let editingImages: RingBraceletImageState[] = []
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
  } else if (editingStage && editingStage.images.length > 0) {
    imageInputDir = editingStage.inputDir
    editingImages = editingStage.images.map(img => ({
      name: img.name,
      status: img.status,
      // Earring's persisted asset is 'compare' (StageImageAssets), not
      // 'frontFullImage' — see EarringImageState's doc comment for why the
      // live job context already normalizes this to frontFullImage; this
      // fallback does the same for the historical/persisted path so
      // RingBraceletImagePreviewPanel renders both without a new component.
      frontFullImage: img.assets?.frontFullImage ?? img.assets?.compare ?? null,
      frontImage: img.assets?.frontImage ?? null,
      detected: img.assets?.detected ?? null,
      needsFixing: img.needsFixing ?? null,
      error: img.error,
      durationMs: img.durationMs,
    }))
  }
  const showingEditingImages = editingImages.length > 0
  const selectedImageState = images.find(img => img.name === selectedImage) ?? images[0] ?? null
  const selectedEditingImageState =
    editingImages.find(img => img.name === selectedImage) ?? editingImages[0] ?? null

  // Refreshed every render — see qaContextRef's own declaration above for
  // why the keyboard effect reads from here instead of closing over these
  // directly.
  qaContextRef.current = {
    editingTitle,
    fullscreen,
    activeList: showingEditingImages ? editingImages : images,
    activeName: (showingEditingImages ? selectedEditingImageState : selectedImageState)?.name ?? null,
    // Needs Fixing only exists for the editing stage's own review flow
    // (Phase 11.5E) — matches RingBraceletImagePreviewPanel's own
    // onToggleNeedsFixing gating exactly.
    canToggleNeedsFixing: showingEditingImages && selectedEditingImageState !== null,
    toggleNeedsFixing: () => {
      if (selectedEditingImageState) {
        void handleToggleNeedsFixing(selectedEditingImageState.name, !selectedEditingImageState.needsFixing)
      }
    },
    openFullscreen: () => setFullscreen(true),
    selectImage: setSelectedImage,
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.stickyTop}>
          {/* Generic label (Phase 10F correction) — onBack's destination now
              varies by entry point (Home, or the Preprocessing listing when
              reached from a live preprocessing run's terminal state). */}
          <button className={styles.backLink} onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={1.5} aria-hidden="true" />
            Back
          </button>

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
                  <Pencil size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </div>
            )}
            <div className={styles.headerRight}>
              <Badge tone={batchStatusTone(batch.status)}>{BATCH_STATUS_LABELS[batch.status]}</Badge>
              <SegmentedControl
                aria-label="Batch mode"
                options={MODE_OPTIONS}
                value={batch.mode ?? 'production'}
                onChange={handleSetMode}
              />
            </div>
          </div>
        </div>

        <BatchDetailsSection title="Overview">
          <div className={styles.pipelineRow}>
            {batch.pipeline.map(type => {
              const stage = batch.stages.find(s => s.type === type)
              return (
                <span key={type} className={styles.pipelineChip}>
                  <Badge tone={stageStatusTone(stage?.status ?? 'not_started')}>
                    {STAGE_LABELS[type]}
                  </Badge>
                </span>
              )
            })}
          </div>

          {preprocessingStage && preprocessingStage.status !== 'not_started' && (
            <div className={styles.stageBlock}>
              <div className={styles.stageBlockLeft}>
                <div className={styles.columnHeading}>Configuration</div>
                <ConfigGrid config={preprocessingStage.config} fields={PREPROCESSING_CONFIG_FIELDS} />
              </div>
              <div className={styles.stageBlockRight}>
                <div className={styles.stageHeader}>
                  <span className={styles.stageName}>{STAGE_LABELS.preprocessing}</span>
                  <Badge tone={stageStatusTone(preprocessingStage.status)}>
                    {STAGE_STATUS_LABELS[preprocessingStage.status]}
                  </Badge>
                </div>
                <StageTiming stage={preprocessingStage} />
                <div className={styles.summaryWrap}>
                  <PreprocessingSummary
                    donePayload={buildDonePayload(preprocessingStage)}
                    fatalError={preprocessingStage.status === 'failed' ? preprocessingStage.error : null}
                    sourceProductType={
                      // "Target" as already displayed in the config grid below
                      // (Phase 10A) — reused here to preselect Continue to
                      // Editing's destination instead of defaulting to Watch.
                      (['watch', 'ring', 'bracelet', 'earring'] as const).find(
                        p => preprocessingStage.config['objectType'] === p
                      )
                    }
                    onEditingHandoff={
                      // Phase 10F: was gated on `batch.currentStage === 'watch'`,
                      // a leftover from pre-10D combined-pipeline Home templates
                      // that no longer exist — nothing can satisfy that anymore
                      // (pipeline is fixed at creation and never grows), so the
                      // hand-off had become permanently unreachable. Gating on
                      // the preprocessing stage's own completion (same check
                      // PreprocessingSummary already makes internally) is what
                      // this condition always meant to express.
                      onEditingHandoff && preprocessingStage.status === 'completed'
                        ? (options) => handleEditingHandoff(preprocessingStage.outputDir ?? '', options)
                        : undefined
                    }
                  />
                </div>
              </div>
            </div>
          )}

          {watchStage && watchStage.status !== 'not_started' && (
            <div className={styles.stageBlock}>
              <div className={styles.stageBlockLeft}>
                <div className={styles.columnHeading}>Configuration</div>
                <ConfigGrid config={watchStage.config} fields={WATCH_CONFIG_FIELDS} />
              </div>
              <div className={styles.stageBlockRight}>
                <div className={styles.stageHeader}>
                  <span className={styles.stageName}>{STAGE_LABELS.watch}</span>
                  <Badge tone={stageStatusTone(watchStage.status)}>
                    {STAGE_STATUS_LABELS[watchStage.status]}
                  </Badge>
                </div>
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
            </div>
          )}

          {editingStage && editingStage.status !== 'not_started' && (
            <div className={styles.stageBlock}>
              <div className={styles.stageBlockLeft}>
                <div className={styles.columnHeading}>Configuration</div>
                <ConfigGrid config={editingStage.config} fields={EDITING_CONFIG_FIELDS} />
              </div>
              <div className={styles.stageBlockRight}>
                <div className={styles.stageHeader}>
                  <span className={styles.stageName}>{STAGE_LABELS.editing}</span>
                  <Badge tone={stageStatusTone(editingStage.status)}>
                    {STAGE_STATUS_LABELS[editingStage.status]}
                  </Badge>
                </div>
                <StageTiming stage={editingStage} />
                <div className={`${styles.metaRow} tabular-nums`}>
                  <span className={styles.inlineStat}>
                    <Check size={12} strokeWidth={2} className={styles.statOk} aria-hidden="true" />
                    {editingStage.counts.succeeded}
                  </span>
                  {editingStage.counts.failed > 0 && (
                    <span className={styles.inlineStat}>
                      <X size={12} strokeWidth={2} className={styles.statErr} aria-hidden="true" />
                      {editingStage.counts.failed}
                    </span>
                  )}
                  {editingStage.counts.needsFixing > 0 && (
                    <span className={styles.inlineStat}>
                      <Flag size={12} strokeWidth={2} className={styles.statReview} aria-hidden="true" />
                      {editingStage.counts.needsFixing} needs fixing
                    </span>
                  )}
                  <span className={styles.metaTotal}>/ {editingStage.counts.total}</span>
                </div>
                {(editingStage.status === 'completed' ||
                  editingStage.status === 'failed' ||
                  editingStage.status === 'cancelled') && (
                  <div className={styles.actions}>
                    <Button variant="ghost" onClick={() => handleRunAnotherEditing(editingProduct)}>
                      Run Another Batch
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className={styles.metaRow}>
            <span>Created {new Date(batch.createdAt).toLocaleString()}</span>
            {completedAt && <span>Completed {new Date(completedAt).toLocaleString()}</span>}
            <span>Duration {batch.durationMs !== null ? formatDurationLong(batch.durationMs) : '—'}</span>
          </div>
        </BatchDetailsSection>

        <BatchDetailsSection
          title="Images"
          actions={
            <ReviewToolbar
              background={reviewBackground}
              onBackgroundChange={setReviewBackground}
              compareMode={reviewCompareMode}
              onCompareModeChange={setReviewCompareMode}
              zoom={reviewZoom}
              onZoomChange={setReviewZoom}
            />
          }
        >
          <div className={styles.imagesLayout}>
            <div className={styles.gridArea}>
              <ThumbnailGrid
                images={
                  showingEditingImages
                    ? editingImages.map(img => ({ ...img, lowConfidence: img.detected === false, needsFixing: img.needsFixing === true }))
                    : images
                }
                inputDir={imageInputDir}
                selectedImage={(showingEditingImages ? selectedEditingImageState : selectedImageState)?.name ?? null}
                onSelect={setSelectedImage}
              />
            </div>
            <div className={styles.previewArea}>
              {showingEditingImages ? (
                <RingBraceletImagePreviewPanel
                  image={selectedEditingImageState}
                  inputDir={imageInputDir}
                  onExpand={() => setFullscreen(true)}
                  onToggleNeedsFixing={handleToggleNeedsFixing}
                  background={reviewBackground}
                  onBackgroundChange={setReviewBackground}
                  showBackgroundToggle={false}
                  compareMode={reviewCompareMode}
                  zoom={reviewZoom}
                  {...(editingProduct === 'earring' ? EARRING_PREVIEW_OVERRIDES : {})}
                />
              ) : (
                <ImagePreviewPanel
                  image={selectedImageState}
                  inputDir={imageInputDir}
                  onExpand={() => setFullscreen(true)}
                  background={reviewBackground}
                  onBackgroundChange={setReviewBackground}
                  showBackgroundToggle={false}
                  compareMode={reviewCompareMode}
                  zoom={reviewZoom}
                />
              )}
            </div>
          </div>
        </BatchDetailsSection>

        {showingEditingImages && editingStage && editingStage.counts.needsFixing > 0 && (
          <BatchDetailsSection
            title="Needs Fixing"
            actions={
              <Badge tone="review">
                {editingStage.counts.needsFixing} flagged
              </Badge>
            }
          >
            <p className={styles.needsFixingHint}>
              Flagged during manual review — excluded from the completed total above. Select one to review it in the Images panel, or press F to unflag.
            </p>
            <ThumbnailGrid
              images={editingImages
                .filter(img => img.needsFixing === true)
                .map(img => ({ ...img, lowConfidence: img.detected === false, needsFixing: true }))}
              inputDir={imageInputDir}
              selectedImage={selectedEditingImageState?.name ?? null}
              onSelect={setSelectedImage}
            />
          </BatchDetailsSection>
        )}

        {fullscreen && (() => {
          const activeList = showingEditingImages ? editingImages : images
          const activeName = (showingEditingImages ? selectedEditingImageState : selectedImageState)?.name ?? null
          const prevName = findAdjacentImage(activeList, activeName, -1)
          const nextName = findAdjacentImage(activeList, activeName, 1)
          return (
            <FullscreenViewer
              title={activeName ?? undefined}
              onClose={() => setFullscreen(false)}
              onPrev={() => prevName && setSelectedImage(prevName)}
              onNext={() => nextName && setSelectedImage(nextName)}
              hasPrev={prevName !== null}
              hasNext={nextName !== null}
            >
              {/* The outer ReviewToolbar (Images section header) is hidden
                  behind this fullscreen dialog, so — unlike the embedded
                  instance above — this one shows its own backdrop toggle
                  rather than relying on keyboard 'B' alone. */}
              {showingEditingImages ? (
                <RingBraceletImagePreviewPanel
                  image={selectedEditingImageState}
                  inputDir={imageInputDir}
                  onToggleNeedsFixing={handleToggleNeedsFixing}
                  background={reviewBackground}
                  onBackgroundChange={setReviewBackground}
                  compareMode={reviewCompareMode}
                  zoom={reviewZoom}
                  {...(editingProduct === 'earring' ? EARRING_PREVIEW_OVERRIDES : {})}
                />
              ) : (
                <ImagePreviewPanel
                  image={selectedImageState}
                  inputDir={imageInputDir}
                  background={reviewBackground}
                  onBackgroundChange={setReviewBackground}
                  compareMode={reviewCompareMode}
                  zoom={reviewZoom}
                />
              )}
            </FullscreenViewer>
          )
        })()}
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
