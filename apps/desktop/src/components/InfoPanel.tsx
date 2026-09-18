import { useAnnotation } from '../context/AnnotationContext'
import { useQueue } from '../context/QueueContext'
import { Badge, type BadgeTone } from './ui/Badge'
import type { BoundaryData } from '../types/annotation'
import styles from './InfoPanel.module.css'

const QUEUE_STATUS_LABELS: Record<string, string> = {
  pending: 'Queuing…',
  queued: 'Queued',
  processing: 'Processing…',
  complete: 'Exported',
  failed: 'Export failed',
}

// Saved-annotation provenance badge (Phase 14A) — 'manual' reads as the
// default/expected case; 'ai'/'ai-adjusted' both read as accent (violet —
// "the machine is working/suggested this"), distinguished by label text
// rather than a second tone. No detection provider exists yet, so in
// practice every saved annotation is still 'manual' today; this is the
// display half of the provenance foundation Phase 14C's real predictions
// will populate.
function provenanceTone(source: BoundaryData['source']): BadgeTone {
  return source === 'manual' ? 'neutral' : 'running'
}

function provenanceLabel(boundary: BoundaryData): string {
  const base = boundary.source === 'manual' ? 'Manual' : boundary.source === 'ai' ? 'AI' : 'AI · adjusted'
  return boundary.confidence === null ? base : `${base} · ${Math.round(boundary.confidence * 100)}%`
}

interface InfoPanelProps {
  onSubmit(): void
  onBack(): void
  onShowDashboard(): void
  onCompleteBatch(): void
}

export function InfoPanel({ onSubmit, onBack, onShowDashboard, onCompleteBatch }: InfoPanelProps) {
  const {
    batch,
    annotations,
    currentIndex,
    mode,
    currentAnnotation,
    currentRow,
    annotatedCount,
    navigate,
    setMode,
    aiDetectionEnabled,
    currentDetectionStatus,
    currentScalePrediction,
    circuitBroken,
    retryDetection,
  } = useAnnotation()
  const { items: queueItems } = useQueue()

  const total = annotations.length
  const isFirst = currentIndex === 0
  const isLast = currentIndex === total - 1

  const queueItem = queueItems.find(item => item.sku === currentAnnotation.sku)
  const missingWidth = !currentRow || currentRow.widthMm <= 0

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onBack}>
          ← Back
        </button>
        <span className={styles.batchLabel}>Batch</span>
        <button className={styles.overviewButton} onClick={onShowDashboard}>
          Overview
        </button>
      </div>

      <section className={styles.section}>
        <div className={styles.skuValue}>{currentAnnotation.sku}</div>
        <div className={styles.statusBadge} data-status={currentAnnotation.status}>
          {currentAnnotation.status === 'annotated' ? 'Annotated' : 'Unannotated'}
        </div>
        {currentAnnotation.status === 'annotated' && (
          <div className={styles.provenanceRow}>
            {currentAnnotation.spliceBoundaries && (
              <Badge tone={provenanceTone(currentAnnotation.spliceBoundaries.source)}>
                Splice · {provenanceLabel(currentAnnotation.spliceBoundaries)}
              </Badge>
            )}
            {currentAnnotation.scaleBoundaries && (
              <Badge tone={provenanceTone(currentAnnotation.scaleBoundaries.source)}>
                Scale · {provenanceLabel(currentAnnotation.scaleBoundaries)}
              </Badge>
            )}
          </div>
        )}
        {queueItem && (
          <div className={styles.processingBadge} data-pstatus={queueItem.status}>
            {QUEUE_STATUS_LABELS[queueItem.status] ?? queueItem.status}
          </div>
        )}
        {queueItem?.status === 'failed' && queueItem.error && (
          <div className={styles.processingError}>{queueItem.error}</div>
        )}
      </section>

      {aiDetectionEnabled && currentAnnotation.status === 'unannotated' && (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>AI Detection</div>
          <AiDetectionStatusRow
            status={currentDetectionStatus}
            circuitBroken={circuitBroken}
            hasScalePrediction={currentScalePrediction !== null}
            measureBy={currentRow?.measureBy ?? 'Case'}
            onRetry={retryDetection}
          />
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Measurements</div>
        <MetaRow label="Width" value={`${currentRow?.widthMm ?? '—'} mm`} />
        <MetaRow label="Height" value={`${currentRow?.heightMm ?? '—'} mm`} />
        <MetaRow label="Measure By" value={currentRow?.measureBy ?? '—'} />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Progress</div>
        <div className={styles.progressRow}>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${total > 0 ? (annotatedCount / total) * 100 : 0}%` }}
            />
          </div>
          <span className={styles.progressCount}>
            {annotatedCount} / {total}
          </span>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Guide Mode</div>
        <div className={styles.modeToggle}>
          <button
            className={styles.modeButton}
            data-active={mode === 'uniform'}
            onClick={() => setMode('uniform')}
          >
            Uniform
          </button>
          <button
            className={styles.modeButton}
            data-active={mode === 'free'}
            onClick={() => setMode('free')}
          >
            Free
          </button>
        </div>
        <p className={styles.modeHint}>
          {mode === 'uniform'
            ? 'Both guides mirror around dial center'
            : 'Guides move independently'}
        </p>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Keyboard</div>
        <div className={styles.keyHints}>
          <KeyHint keys={['←', '→']} label="Nudge 1px" />
          <KeyHint keys={['⇧←', '⇧→']} label="Nudge 10px" />
        </div>
      </section>

      <div className={styles.controls}>
        <div className={styles.navRow}>
          <button className={styles.navButton} onClick={() => navigate(-1)} disabled={isFirst}>
            Previous
          </button>
          <span className={styles.indexLabel}>
            {currentIndex + 1} of {total}
          </span>
          <button className={styles.navButton} onClick={() => navigate(1)} disabled={isLast}>
            Next
          </button>
        </div>

        {missingWidth && (
          <div className={styles.submitWarning}>Width is 0 mm — check the spreadsheet</div>
        )}
        <button className={styles.submitButton} onClick={onSubmit} disabled={missingWidth}>
          Submit
        </button>
        <button className={styles.completeButton} onClick={onCompleteBatch}>
          Complete Batch
        </button>
      </div>
    </div>
  )
}

// AI Detection status (Phase 14C) — a single combined status, not a
// per-boundary-type one: one boundary:detect call resolves both splice and
// scale together, so there's no meaningful separate "splice detecting,
// scale detecting" state to show (unlike the post-submission provenance
// badges above, which really are two independent, already-settled facts).
// No confidence percentage anywhere here — the live API schema has none.
interface AiDetectionStatusRowProps {
  status: 'idle' | 'pending' | 'success' | 'failed'
  circuitBroken: boolean
  hasScalePrediction: boolean
  measureBy: string
  onRetry(): void
}

function AiDetectionStatusRow({ status, circuitBroken, hasScalePrediction, measureBy, onRetry }: AiDetectionStatusRowProps) {
  if (circuitBroken) {
    return (
      <div className={styles.aiRow}>
        <Badge tone="warning">AI detection unavailable — continuing manually</Badge>
        <button className={styles.retryButton} onClick={onRetry}>Retry</button>
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className={styles.aiRow}>
        <Badge tone="warning">Detection failed — using default guides</Badge>
        <button className={styles.retryButton} onClick={onRetry}>Retry</button>
      </div>
    )
  }
  if (status === 'success') {
    // Dial watches can partially succeed — case_bbox detected (splice
    // populated) but dial_bbox missing/invalid (scale still needs manual
    // placement). Case watches always succeed-or-fail together (scale
    // mirrors splice), so this distinction only ever applies to Dial.
    const isDial = measureBy.toLowerCase() === 'dial'
    const label =
      isDial && !hasScalePrediction
        ? 'AI case boundary applied — dial not detected, set scale manually'
        : 'AI boundaries applied'
    return <Badge tone="success">{label}</Badge>
  }
  return <Badge tone="running">Detecting…</Badge>
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metaRow}>
      <span className={styles.metaLabel}>{label}</span>
      <span className={styles.metaValue}>{value}</span>
    </div>
  )
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className={styles.keyHint}>
      <span className={styles.keyHintKeys}>
        {keys.map(k => (
          <kbd key={k} className={styles.kbd}>
            {k}
          </kbd>
        ))}
      </span>
      <span className={styles.keyHintLabel}>{label}</span>
    </div>
  )
}
