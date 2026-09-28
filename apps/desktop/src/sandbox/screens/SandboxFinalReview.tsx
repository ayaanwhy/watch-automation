import { useEffect, useMemo, useState } from 'react'
import { Maximize2, PackageX } from 'lucide-react'
import { PageHeader } from '../../components/ui/PageHeader'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { EmptyState } from '../../components/ui/EmptyState'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { ReviewToolbar } from '../../components/batch/ReviewToolbar'
import { ThumbnailGrid, findAdjacentImage } from '../../components/shared/ThumbnailGrid'
import type { ThumbnailStatus } from '../../components/shared/ThumbnailCell'
import { FullscreenViewer } from '../../components/ui/FullscreenViewer'
import { BeforeAfterSlider, type ComparisonBackground, type CompareMode } from '../../components/shared/BeforeAfterSlider'
import { toFileUrl } from '../../lib/paths'
import { SandboxRejectionDialog } from '../components/SandboxRejectionDialog'
import { SANDBOX_PRODUCT_GLYPHS, SANDBOX_PRODUCT_LABELS, sortSandboxProductTypes } from '../constants/productDisplay'
import { useSandboxWorkflow } from '../context/SandboxWorkflowContext'
import {
  filterSandboxReviewItems,
  isItemActionable,
  isItemReviewable,
  isRunReviewable,
  summarizeSandboxReview,
} from '../lib/sandboxReviewData'
import { sandboxReviewItemKey, REVIEW_STATUS_FILTERS } from '../types/sandboxReview'
import type { SandboxReviewItem, SandboxReviewProductFilter, SandboxReviewStatusFilter } from '../types/sandboxReview'
import type { SandboxEditor } from '../types/sandboxDisposition'
import type { SandboxRunDetail } from '../types/sandboxRun'
import styles from './SandboxFinalReview.module.css'

interface SandboxFinalReviewProps {
  onBack: () => void
}

const STATUS_FILTER_LABELS: Record<SandboxReviewStatusFilter, string> = {
  all: 'All',
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed / Unavailable',
}

function toThumbnailStatus(item: SandboxReviewItem): ThumbnailStatus {
  switch (item.processingStatus) {
    case 'completed':
      return 'completed'
    case 'queued':
      return 'pending'
    case 'running':
      return 'processing'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
    case 'unavailable':
    default:
      return 'failed'
  }
}

// Sandbox Final Review (Phase 15.6) — reuses Batch Details' exact review
// primitives (ThumbnailGrid, BeforeAfterSlider, FullscreenViewer,
// ReviewToolbar) rather than a second viewer implementation; only the
// data feeding them is Sandbox-specific. Fetches review items fresh on
// mount (works identically whether reopened right after a run finishes or
// after a full renderer reload — nothing here depends on in-memory state
// surviving).
// The "before" side of the comparison. Gemstone's trimmed `;compare` is the
// canonical before/reference artifact (the final is its `;frontImage`); every
// other product compares against its original source image, as before.
function beforePathFor(item: SandboxReviewItem): string {
  if (item.productType === 'gemstone' && item.compareOutputPath) return item.compareOutputPath
  return item.sourceImagePath ?? item.outputPath ?? ''
}

export default function SandboxFinalReview({ onBack }: SandboxFinalReviewProps) {
  const { activeRun } = useSandboxWorkflow()
  const runId = activeRun?.id ?? null
  const [run, setRun] = useState<SandboxRunDetail | null>(null)
  const [items, setItems] = useState<SandboxReviewItem[] | null>(null)
  const [editors, setEditors] = useState<SandboxEditor[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState<SandboxReviewStatusFilter>('all')
  const [productFilter, setProductFilter] = useState<SandboxReviewProductFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())

  const [background, setBackground] = useState<ComparisonBackground>('transparent')
  const [compareMode, setCompareMode] = useState<CompareMode>('slider')
  const [zoom, setZoom] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function load() {
    if (!runId) {
      setLoadError('No Sandbox run is selected. Go to the Dashboard and resume or start a run first.')
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    const [runResult, itemsResult, editorsResult] = await Promise.all([
      window.api.invoke('sandbox:get-run', { id: runId }),
      window.api.invoke('sandbox:get-review-items', { id: runId }),
      window.api.invoke('sandbox:list-editors'),
    ])
    if (!runResult || !itemsResult) {
      setLoadError('This Sandbox run could not be loaded.')
      setLoading(false)
      return
    }
    setRun(runResult)
    setItems(itemsResult)
    setEditors(editorsResult)
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  const itemByKey = useMemo(() => new Map((items ?? []).map(i => [sandboxReviewItemKey(i.productType, i.sku), i])), [items])

  const presentProductTypes = useMemo(
    () => sortSandboxProductTypes(Array.from(new Set((items ?? []).map(i => i.productType)))),
    [items],
  )

  const filtered = useMemo(
    () => (items ? filterSandboxReviewItems(items, statusFilter, productFilter) : []),
    [items, statusFilter, productFilter],
  )

  const summary = useMemo(() => summarizeSandboxReview(items ?? []), [items])

  if (loading) {
    return (
      <div className={styles.page}>
        <PageHeader title="Final Review" subtitle="Loading…" />
      </div>
    )
  }

  if (loadError || !run || !items) {
    return (
      <div className={styles.emptyWrap}>
        <EmptyState icon={PackageX} message={loadError ?? 'This run could not be loaded.'} actionLabel="Back" onAction={onBack} />
      </div>
    )
  }

  if (!isRunReviewable(run, items)) {
    return (
      <div className={styles.page}>
        <PageHeader sticky title="Final Review" subtitle={run.title} actions={<Button variant="ghost" onClick={onBack}>← Back</Button>} />
        <div className={styles.emptyWrap}>
          <EmptyState
            icon={PackageX}
            message={
              run.status === 'running' || run.status === 'validating' || run.status === 'draft'
                ? 'This run is still processing — Final Review becomes available once it finishes.'
                : run.status === 'cancelled'
                  ? 'This run was cancelled — nothing is available to review.'
                  : 'This run produced no reviewable output.'
            }
          />
        </div>
      </div>
    )
  }

  // TS doesn't retain `run`'s non-null narrowing inside the nested handler
  // functions below (a known limitation for closures defined after a
  // control-flow guard) — this plain string capture sidesteps it.
  const confirmedRunId = run.id
  const selectedItem = selectedKey ? (itemByKey.get(selectedKey) ?? null) : null
  const gridImages = filtered.map(item => ({
    name: sandboxReviewItemKey(item.productType, item.sku),
    status: toThumbnailStatus(item),
    needsFixing: item.disposition.state === 'rejected',
  }))

  function getSourcePath(image: { name: string }): string {
    const item = itemByKey.get(image.name)
    return item?.outputPath ?? item?.sourceImagePath ?? ''
  }

  function toggleCheck(key: string) {
    const item = itemByKey.get(key)
    if (!item || !isItemActionable(item)) return // section 17 — never select a non-actionable item
    setCheckedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectAllActionable() {
    setCheckedKeys(new Set(filtered.filter(isItemActionable).map(i => sandboxReviewItemKey(i.productType, i.sku))))
  }

  function clearSelection() {
    setCheckedKeys(new Set())
  }

  const checkedActionableItems = Array.from(checkedKeys)
    .map(k => itemByKey.get(k))
    .filter((i): i is SandboxReviewItem => !!i && isItemActionable(i))

  async function handleApproveSelected() {
    if (checkedActionableItems.length === 0) return
    setActionBusy(true)
    setActionError(null)
    const result = await window.api.invoke('sandbox:approve-items', {
      runId: confirmedRunId,
      keys: checkedActionableItems.map(i => ({ productType: i.productType, sku: i.sku })),
    })
    setActionBusy(false)
    if (!result.ok) setActionError('Some items could not be approved — see their status for details.')
    clearSelection()
    await load()
  }

  async function handleConfirmReject(input: { reason: string; instructions: string | null; editor: SandboxEditor }) {
    if (checkedActionableItems.length === 0) return
    setActionBusy(true)
    setActionError(null)
    const result = await window.api.invoke('sandbox:reject-items', {
      runId: confirmedRunId,
      keys: checkedActionableItems.map(i => ({ productType: i.productType, sku: i.sku })),
      reason: input.reason,
      instructions: input.instructions,
      editor: input.editor,
    })
    setActionBusy(false)
    setRejecting(false)
    if (!result.ok) setActionError('Some items could not be rejected — see their status for details.')
    clearSelection()
    await load()
  }

  async function approveOne(item: SandboxReviewItem) {
    setActionBusy(true)
    setActionError(null)
    const result = await window.api.invoke('sandbox:approve-items', { runId: confirmedRunId, keys: [{ productType: item.productType, sku: item.sku }] })
    setActionBusy(false)
    if (!result.ok) setActionError('This item could not be approved.')
    await load()
  }

  const previewNode = selectedItem ? (
    selectedItem.outputPath ? (
      <BeforeAfterSlider
        key={selectedKey}
        beforeSrc={toFileUrl(beforePathFor(selectedItem))}
        afterSrc={toFileUrl(selectedItem.outputPath)}
        beforeLabel="Source"
        afterLabel="Editing Output"
        background={background}
        onBackgroundChange={setBackground}
        showBackgroundToggle={false}
        compareMode={compareMode}
        zoom={zoom}
      />
    ) : (
      <div className={styles.noOutput}>
        {selectedItem.processingError ?? 'No usable output was produced for this item.'}
      </div>
    )
  ) : (
    <div className={styles.noOutput}>Select an item to preview.</div>
  )

  return (
    <div className={styles.page}>
      <PageHeader
        sticky
        title="Final Review"
        subtitle={`${run.title} — ${summary.pending} pending · ${summary.approved} approved · ${summary.rejected} rejected · ${summary.notReviewable} failed/unavailable`}
        actions={
          <Button variant="ghost" onClick={onBack}>
            ← Back
          </Button>
        }
      />

      <div className={styles.filterRow}>
        <SegmentedControl
          variant="pill"
          aria-label="Filter by status"
          options={REVIEW_STATUS_FILTERS.map(v => ({ value: v, label: STATUS_FILTER_LABELS[v] }))}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <SegmentedControl
          variant="pill"
          aria-label="Filter by product"
          options={[
            { value: 'all' as const, label: 'All Products' },
            ...presentProductTypes.map(p => ({ value: p, label: SANDBOX_PRODUCT_LABELS[p] })),
          ]}
          value={productFilter}
          onChange={setProductFilter}
        />
      </div>

      <div className={styles.bulkBar}>
        <Button variant="ghost" size="sm" onClick={selectAllActionable} disabled={filtered.filter(isItemActionable).length === 0}>
          Select All Actionable
        </Button>
        <Button variant="ghost" size="sm" onClick={clearSelection} disabled={checkedKeys.size === 0}>
          Clear Selection
        </Button>
        <span className={styles.bulkCount}>{checkedActionableItems.length} selected</span>
        <div className={styles.bulkActions}>
          <Button onClick={handleApproveSelected} disabled={checkedActionableItems.length === 0 || actionBusy} loading={actionBusy}>
            Approve Selected
          </Button>
          <Button variant="danger" onClick={() => setRejecting(true)} disabled={checkedActionableItems.length === 0 || actionBusy}>
            Reject Selected
          </Button>
        </div>
      </div>

      {actionError && <div className={styles.errorBanner}>{actionError}</div>}

      <div className={styles.body}>
        <div className={styles.gridPane}>
          <ThumbnailGrid
            images={gridImages}
            getSourcePath={getSourcePath}
            selectedImage={selectedKey}
            onSelect={setSelectedKey}
            checkedNames={checkedKeys}
            onToggleCheck={toggleCheck}
          />
        </div>

        <div className={styles.previewPane}>
          <ReviewToolbar
            background={background}
            onBackgroundChange={setBackground}
            compareMode={compareMode}
            onCompareModeChange={setCompareMode}
            zoom={zoom}
            onZoomChange={setZoom}
          />

          {selectedItem && (
            <div className={styles.itemInfo}>
              {(() => {
                const Glyph = SANDBOX_PRODUCT_GLYPHS[selectedItem.productType]
                return <Glyph size={16} strokeWidth={1.5} />
              })()}
              <span className={styles.itemSku}>{selectedItem.sku}</span>
              <Badge tone={isItemReviewable(selectedItem) ? 'neutral' : 'warning'}>{toThumbnailStatus(selectedItem)}</Badge>
              <Badge
                tone={
                  selectedItem.disposition.state === 'approved'
                    ? 'success'
                    : selectedItem.disposition.state === 'rejected'
                      ? 'review'
                      : 'neutral'
                }
              >
                {selectedItem.disposition.state}
              </Badge>
              {!selectedItem.postProcessingComplete && isItemReviewable(selectedItem) && (
                <span className={styles.postProcessingNote}>Post Processing not yet available — showing Editing output.</span>
              )}
              {selectedItem.outputPath && (
                <button
                  className={styles.expandButton}
                  onClick={() => setFullscreen(true)}
                  aria-label="View fullscreen"
                  title="View fullscreen"
                >
                  <Maximize2 size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          <div className={styles.previewBox}>{previewNode}</div>

          {selectedItem && isItemActionable(selectedItem) && (
            <div className={styles.itemActions}>
              <Button size="sm" onClick={() => void approveOne(selectedItem)} disabled={actionBusy}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setCheckedKeys(new Set([selectedKey!]))
                  setRejecting(true)
                }}
                disabled={actionBusy}
              >
                Reject
              </Button>
            </div>
          )}
        </div>
      </div>

      {fullscreen && selectedItem && selectedItem.outputPath && (
        <FullscreenViewer
          onClose={() => setFullscreen(false)}
          onPrev={() => {
            const prev = findAdjacentImage(gridImages, selectedKey, -1)
            if (prev) setSelectedKey(prev)
          }}
          onNext={() => {
            const next = findAdjacentImage(gridImages, selectedKey, 1)
            if (next) setSelectedKey(next)
          }}
          hasPrev={findAdjacentImage(gridImages, selectedKey, -1) !== null}
          hasNext={findAdjacentImage(gridImages, selectedKey, 1) !== null}
          title={selectedItem.sku}
        >
          <BeforeAfterSlider
            key={`fullscreen-${selectedKey}`}
            beforeSrc={toFileUrl(beforePathFor(selectedItem))}
            afterSrc={toFileUrl(selectedItem.outputPath)}
            beforeLabel="Source"
            afterLabel="Editing Output"
            background={background}
            onBackgroundChange={setBackground}
            compareMode={compareMode}
            zoom={zoom}
          />
        </FullscreenViewer>
      )}

      {rejecting && (
        <SandboxRejectionDialog
          itemCount={checkedActionableItems.length}
          editors={editors}
          defaultEditorId={editors[0]?.id ?? null}
          submitting={actionBusy}
          onClose={() => setRejecting(false)}
          onConfirm={input => void handleConfirmReject(input)}
        />
      )}
    </div>
  )
}
