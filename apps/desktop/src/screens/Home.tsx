import { useEffect, useRef, useState } from 'react'
import { Layers, Gem, Eye, Flag, CalendarCheck, Activity } from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Select } from '../components/ui/Select'
import { Button } from '../components/ui/Button'
import { BatchCard } from '../components/batch/BatchCard'
import { NowCard, type NowCardKind } from '../components/dashboard/NowCard'
import { AttentionTile } from '../components/dashboard/AttentionTile'
import { QuickLaunchTile } from '../components/dashboard/QuickLaunchTile'
import { PixelShimmer } from '../components/dashboard/PixelShimmer'
import { EmptyState } from '../components/ui/EmptyState'
import { usePreprocessingJob } from '../context/PreprocessingJobContext'
import { useRingBraceletJob } from '../context/RingBraceletJobContext'
import { useEarringJob } from '../context/EarringJobContext'
import type { ProgressState } from '../context/useSubprocessJob'
import type { BatchDetailRecord, BatchMode, BatchProductType, BatchStatus, BatchSummaryRecord } from '../types/batch'
import styles from './Home.module.css'

// Home's own entry-id vocabulary — no longer maps 1:1 onto a resolved
// pipeline (Phase 10D): 'editing' can't resolve to a StageType[] yet, since
// which product (and therefore which stage type — 'watch' or 'editing') is
// chosen on the next screen, not here. See App.tsx's handleLaunchFromHome.
export type HomeEntryId = 'preprocessing' | 'editing'

interface HomeProps {
  // Navigates into the chosen entry's screen with an optional custom title
  // and mode. No Batch is created here — creation happens at the workflow's
  // execution action (Start / Begin Annotation), so this produces the exact
  // same downstream result as entering the same workflow via the sidebar
  // (which always defaults to Production — see App.tsx's navigate()).
  onLaunch: (entry: HomeEntryId, title: string, mode: BatchMode) => void
  // Reopens an existing batch (Phase 9E) — an in-progress batch reopens into
  // its live stage; a finished one opens the permanent Batch Details screen.
  onOpenBatch: (id: string) => void
  // Now zone product-glyph fidelity (Phase 13D) — BatchSummaryRecord (what
  // batch-registry:list returns) has no product field, only a stage's full
  // config does. App.tsx already tracks these two full detail records for
  // its own live-workspace routing; passing them through here (mirroring
  // Sidebar's identical Phase 13C plumbing) gives the Now zone precise
  // glyphs for whichever batches are actually running, with no new IPC.
  preprocessBatch: BatchDetailRecord | null
  editingBatch: BatchDetailRecord | null
}

// Stage here means pipeline category, not product — Watch moved to the
// Product Type filter below (it's a product, not a stage; its underlying
// StageType is still 'watch', matched via WATCH_STAGE_TYPES in the filter
// predicate). 'editing' covers Ring/Bracelet/Earring/Watch's shared stage
// type; 'preprocessing' covers all products that pass through it.
type StageFilter = 'all' | 'preprocessing' | 'editing'
type ModeFilter = 'all' | BatchMode
type ProductTypeFilter = 'all' | BatchProductType
type StatusFilterValue = 'all' | BatchStatus
type AttentionFilter = null | 'waitingReview' | 'needsFixing' | 'completedToday' | 'running'

const STAGE_FILTER_OPTIONS: { value: StageFilter; label: string }[] = [
  { value: 'all', label: 'All stages' },
  { value: 'preprocessing', label: 'Preprocessing' },
  { value: 'editing', label: 'Editing' },
]

const MODE_FILTER_OPTIONS: { value: ModeFilter; label: string }[] = [
  { value: 'all', label: 'All modes' },
  { value: 'production', label: 'Production' },
  { value: 'testing', label: 'Testing' },
]

// Watch's own pipeline runs its stage as StageType 'watch', not 'editing' —
// see batch.ts's StageType comment. Product Type filtering must still work
// across both Preprocessing and Editing batches, so this list covers every
// product a batch's productType (computeProductType in batchModel.ts) can
// resolve to, independent of which stage carries it. 'generic' (a
// Preprocessing-only objectType) is intentionally omitted — not part of the
// four requested product tiles.
const PRODUCT_TYPE_FILTER_OPTIONS: { value: ProductTypeFilter; label: string }[] = [
  { value: 'all', label: 'All products' },
  { value: 'ring', label: 'Rings' },
  { value: 'bracelet', label: 'Bracelets' },
  { value: 'earring', label: 'Earrings' },
  { value: 'watch', label: 'Watch' },
]

// Compact dropdown (not segmented) per the Dashboard polish pass — a status
// row with six values reads better as a single trigger than six pills.
const STATUS_FILTER_OPTIONS: { value: StatusFilterValue; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'queued', label: 'In Queue' },
  { value: 'in_progress', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

function isToday(iso: string): boolean {
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

// Attention row's "Running" tile only needs the single soonest ETA number,
// not the full estimate object NowCard/lib/eta.ts's estimateEta returns.
function estimateEtaMsFor(progress: { completed: number; total: number }, startedAt: number | null): number | null {
  if (startedAt === null || progress.completed <= 0 || progress.total <= 0) return null
  const elapsedMs = Date.now() - startedAt
  if (elapsedMs <= 0) return null
  const remaining = Math.max(0, progress.total - progress.completed)
  return remaining === 0 ? 0 : (elapsedMs / progress.completed) * remaining
}

// Fires the ~600ms completion-moment pulse (Motion Language: "check-draw +
// one soft violet pulse on the finishing batch card, ~600ms, once") on
// whichever batch id a job transitions running → done into, while the
// Dashboard is mounted. Mirrors JobCompletionToasts' phase-transition
// pattern (per-job prevPhase refs) rather than a generic loop, for the same
// reason that component uses one: explicit, easy-to-audit per-job effects.
function useCompletionPulse(
  preprocessingPhase: string,
  ringBraceletPhase: string,
  earringPhase: string,
  preprocessBatchId: string | undefined,
  editingBatchId: string | undefined,
) {
  const [pulseIds, setPulseIds] = useState<Set<string>>(new Set())
  const prevPreprocessing = useRef(preprocessingPhase)
  const prevRingBracelet = useRef(ringBraceletPhase)
  const prevEarring = useRef(earringPhase)

  function pulseOnce(id: string) {
    setPulseIds(prev => new Set(prev).add(id))
    window.setTimeout(() => {
      setPulseIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 700)
  }

  useEffect(() => {
    if (prevPreprocessing.current === 'running' && preprocessingPhase === 'done' && preprocessBatchId) {
      pulseOnce(preprocessBatchId)
    }
    prevPreprocessing.current = preprocessingPhase
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preprocessingPhase, preprocessBatchId])

  useEffect(() => {
    if (prevRingBracelet.current === 'running' && ringBraceletPhase === 'done' && editingBatchId) {
      pulseOnce(editingBatchId)
    }
    prevRingBracelet.current = ringBraceletPhase
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringBraceletPhase, editingBatchId])

  useEffect(() => {
    if (prevEarring.current === 'running' && earringPhase === 'done' && editingBatchId) {
      pulseOnce(editingBatchId)
    }
    prevEarring.current = earringPhase
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earringPhase, editingBatchId])

  return pulseIds
}

interface NowEntry {
  kind: NowCardKind
  id: string
  title: string
  progress: ProgressState
  startedAt: number | null
}

// Home → Dashboard (Phase 13D, Library archetype). Three zones: Now (live
// running-batch cards, collapsing to a quiet idle strip with the
// pixel-shimmer motif), Attention (four stat tiles, each a filter onto the
// library below), and the Recent batches library itself (filterable,
// quick-launch tiles). Replaces the old modal-based "New Batch" flow with
// direct quick-launch tiles (Decision 14).
export default function Home({ onLaunch, onOpenBatch, preprocessBatch, editingBatch }: HomeProps) {
  const [batches, setBatches] = useState<BatchSummaryRecord[]>([])
  const [stageFilter, setStageFilter] = useState<StageFilter>('all')
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('all')
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>(null)

  const preprocessingJob = usePreprocessingJob()
  const ringBraceletJob = useRingBraceletJob()
  const earringJob = useEarringJob()

  const pulseIds = useCompletionPulse(
    preprocessingJob.phase,
    ringBraceletJob.phase,
    earringJob.phase,
    preprocessBatch?.id,
    editingBatch?.id,
  )

  function refetch() {
    void window.api.invoke('batch-registry:list').then(setBatches)
  }

  useEffect(() => {
    refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh the list on every completion so a batch that just finished (and
  // is about to receive the completion pulse) shows its real terminal state
  // instead of the stale snapshot from mount.
  useEffect(() => {
    refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preprocessingJob.phase, ringBraceletJob.phase, earringJob.phase])

  function handleRenamed(updated: BatchSummaryRecord) {
    setBatches(prev => prev.map(b => (b.id === updated.id ? updated : b)))
  }

  function handleDeleted(id: string) {
    setBatches(prev => prev.filter(b => b.id !== id))
    // Queueing (Item 5A, post-Phase-13 polish) — a queued batch's payload
    // lives only in its job hook's in-memory queue (see useSubprocessJob),
    // not the registry record just deleted above. Without this, deleting a
    // still-queued batch here would leave that payload to drain and run
    // later against a batchId that no longer exists. Harmless no-op for any
    // id that isn't actually queued in a given hook.
    preprocessingJob.cancelQueued(id)
    ringBraceletJob.cancelQueued(id)
    earringJob.cancelQueued(id)
  }

  function toggleAttentionFilter(next: Exclude<AttentionFilter, null>) {
    setAttentionFilter(current => (current === next ? null : next))
  }

  // ── Now zone — real-time job data, not the (potentially stale) batches
  // list, so it reflects the current image/stage the instant it changes. ──
  const nowEntries: NowEntry[] = []
  if (preprocessingJob.phase === 'running' && preprocessBatch) {
    nowEntries.push({
      kind: 'preprocessing',
      id: preprocessBatch.id,
      title: preprocessBatch.title,
      progress: preprocessingJob.progress,
      startedAt: preprocessingJob.startedAt,
    })
  }
  const editingProductConfig = editingBatch?.stages.find(s => s.type === 'editing')?.config['product']
  if (ringBraceletJob.phase === 'running' && editingBatch) {
    nowEntries.push({
      kind: editingProductConfig === 'bracelet' ? 'bracelet' : 'ring',
      id: editingBatch.id,
      title: editingBatch.title,
      progress: ringBraceletJob.progress,
      startedAt: ringBraceletJob.startedAt,
    })
  }
  if (earringJob.phase === 'running' && editingBatch) {
    nowEntries.push({
      kind: 'earring',
      id: editingBatch.id,
      title: editingBatch.title,
      progress: earringJob.progress,
      startedAt: earringJob.startedAt,
    })
  }

  // ── Attention row — derived entirely from the already-fetched summary
  // list (no per-batch detail fetches). "Waiting review": a completed
  // Ring/Bracelet/Earring batch (pipeline is always ['editing'] alone for
  // these — see BatchDetails.tsx) whose rolled-up counts still show
  // unresolved low-confidence images. ──
  const waitingReviewBatches = batches.filter(
    b => b.pipeline.includes('editing') && b.status === 'completed' && b.counts.lowConfidence > 0,
  )
  const needsFixingBatches = batches.filter(b => b.counts.needsFixing > 0)
  const needsFixingTotal = needsFixingBatches.reduce((sum, b) => sum + b.counts.needsFixing, 0)
  const completedTodayBatches = batches.filter(b => b.status === 'completed' && isToday(b.updatedAt))
  const runningBatches = batches.filter(b => b.status === 'in_progress')
  const soonestEtaMs = nowEntries
    .map(e => estimateEtaMsFor(e.progress, e.startedAt))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b)[0]

  // ── Recent batches library ──
  const waitingReviewIds = new Set(waitingReviewBatches.map(b => b.id))
  const needsFixingIds = new Set(needsFixingBatches.map(b => b.id))
  const completedTodayIds = new Set(completedTodayBatches.map(b => b.id))
  const filteredBatches = batches.filter(b => {
    // Watch's pipeline stage is StageType 'watch', not 'editing' — the
    // Stage filter's 'editing' option means "editing-category work", which
    // for filtering purposes includes Watch's own stage (Watch moved to the
    // Product Type filter; it no longer has a dedicated Stage option).
    if (stageFilter === 'preprocessing' && !b.pipeline.includes('preprocessing')) return false
    if (stageFilter === 'editing' && !b.pipeline.includes('editing') && !b.pipeline.includes('watch')) return false
    if (modeFilter !== 'all' && (b.mode ?? 'production') !== modeFilter) return false
    if (productTypeFilter !== 'all' && b.productType !== productTypeFilter) return false
    if (statusFilter !== 'all' && b.status !== statusFilter) return false
    if (attentionFilter === 'waitingReview' && !waitingReviewIds.has(b.id)) return false
    if (attentionFilter === 'needsFixing' && !needsFixingIds.has(b.id)) return false
    if (attentionFilter === 'completedToday' && !completedTodayIds.has(b.id)) return false
    if (attentionFilter === 'running' && b.status !== 'in_progress') return false
    return true
  })

  const hasAnyFilter =
    stageFilter !== 'all' ||
    modeFilter !== 'all' ||
    productTypeFilter !== 'all' ||
    statusFilter !== 'all' ||
    attentionFilter !== null

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <PageHeader sticky title="Dashboard" subtitle="Your batches — launch a new one or reopen previous work." />

        <section className={styles.nowZone}>
          {nowEntries.length > 0 ? (
            <div className={styles.nowRow}>
              {nowEntries.map(e => (
                <NowCard
                  key={e.id + e.kind}
                  kind={e.kind}
                  title={e.title}
                  progress={e.progress}
                  startedAt={e.startedAt}
                  onOpen={() => onOpenBatch(e.id)}
                />
              ))}
            </div>
          ) : (
            <div className={styles.idleHero}>
              <PixelShimmer />
              <EmptyState icon={Activity} message="Nothing running right now." />
            </div>
          )}
        </section>

        <section className={styles.attentionRow}>
          <AttentionTile
            icon={Eye}
            label="Waiting review"
            value={waitingReviewBatches.length}
            tone="review"
            active={attentionFilter === 'waitingReview'}
            onClick={waitingReviewBatches.length > 0 ? () => toggleAttentionFilter('waitingReview') : undefined}
          />
          <AttentionTile
            icon={Flag}
            label="Needs Fixing"
            value={needsFixingBatches.length}
            detail={needsFixingTotal > 0 ? `${needsFixingTotal} image${needsFixingTotal === 1 ? '' : 's'} flagged` : undefined}
            tone="review"
            active={attentionFilter === 'needsFixing'}
            onClick={needsFixingBatches.length > 0 ? () => toggleAttentionFilter('needsFixing') : undefined}
          />
          <AttentionTile
            icon={CalendarCheck}
            label="Completed today"
            value={completedTodayBatches.length}
            active={attentionFilter === 'completedToday'}
            onClick={completedTodayBatches.length > 0 ? () => toggleAttentionFilter('completedToday') : undefined}
          />
          <AttentionTile
            icon={Activity}
            label="Running"
            value={runningBatches.length}
            detail={soonestEtaMs !== undefined ? `Soonest ~${Math.max(1, Math.round(soonestEtaMs / 60000))}m` : undefined}
            tone="running"
            active={attentionFilter === 'running'}
            onClick={runningBatches.length > 0 ? () => toggleAttentionFilter('running') : undefined}
          />
        </section>

        <section className={styles.quickLaunchRow}>
          <QuickLaunchTile
            icon={Layers}
            label="Preprocessing"
            description="Background removal, segmentation, upscaling"
            onClick={() => onLaunch('preprocessing', '', 'production')}
          />
          <QuickLaunchTile
            icon={Gem}
            label="Editing"
            description="Watch, Ring, Bracelet, or Earring assets"
            onClick={() => onLaunch('editing', '', 'production')}
          />
        </section>

        <section className={styles.library}>
          <div className={styles.libraryHeader}>
            <h2 className={styles.libraryTitle}>Recent batches</h2>
            {hasAnyFilter && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStageFilter('all')
                  setModeFilter('all')
                  setProductTypeFilter('all')
                  setStatusFilter('all')
                  setAttentionFilter(null)
                }}
              >
                Clear filters
              </Button>
            )}
          </div>

          {batches.length > 0 && (
            <div className={styles.filterRow}>
              <SegmentedControl
                variant="pill"
                aria-label="Filter by stage"
                options={STAGE_FILTER_OPTIONS}
                value={stageFilter}
                onChange={setStageFilter}
              />
              <SegmentedControl
                variant="pill"
                aria-label="Filter by mode"
                options={MODE_FILTER_OPTIONS}
                value={modeFilter}
                onChange={setModeFilter}
              />
              <SegmentedControl
                variant="pill"
                aria-label="Filter by product type"
                options={PRODUCT_TYPE_FILTER_OPTIONS}
                value={productTypeFilter}
                onChange={setProductTypeFilter}
              />
              <div className={styles.statusFilter}>
                <Select
                  options={STATUS_FILTER_OPTIONS}
                  value={statusFilter}
                  onChange={setStatusFilter}
                  active={statusFilter !== 'all'}
                />
              </div>
            </div>
          )}

          {filteredBatches.length === 0 ? (
            <EmptyState
              icon={Layers}
              message={
                batches.length === 0
                  ? 'No batches yet. Launch Preprocessing or Editing above to get started.'
                  : 'No batches match these filters.'
              }
            />
          ) : (
            <div className={styles.list}>
              {filteredBatches.map(b => (
                <BatchCard
                  key={b.id}
                  batch={b}
                  onOpen={() => onOpenBatch(b.id)}
                  onRenamed={handleRenamed}
                  onDeleted={handleDeleted}
                  justCompleted={pulseIds.has(b.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
