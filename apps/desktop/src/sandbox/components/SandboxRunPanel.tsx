import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Badge, type BadgeTone } from '../../components/ui/Badge'
import { SANDBOX_PRODUCT_GLYPHS, SANDBOX_PRODUCT_LABELS } from '../constants/productDisplay'
import { summarizeImageProgress, type SandboxProductImageProgress } from '../lib/sandboxRunProgress'
import { AutomationErrorNotice } from './AutomationErrorNotice'
import type { SandboxRunDetail, SandboxExecutionStatus, SandboxItemStage, SandboxRunItemState } from '../types/sandboxRun'
import type { SandboxProductType } from '../types/sandboxProduct'
import styles from './SandboxRunPanel.module.css'

interface SandboxRunPanelProps {
  run: SandboxRunDetail
  onCancel: () => void
  // Shown once the run has reached a non-running, non-cancelled terminal
  // status. Whether the run actually has anything reviewable is decided by
  // the Final Review screen itself once opened.
  onReview?: () => void
  // Starts a fresh run with the same batch/configuration (shown when the run
  // ended failed, partially completed or cancelled).
  onRetry?: () => void
  // Retries ONE failed image; resolves with a refusal message, or null when
  // the retry started (its progress then streams like any image's).
  onRetryImage?: (productType: SandboxProductType, sku: string) => Promise<string | null>
}

const REVIEWABLE_STATUSES = new Set<SandboxRunDetail['status']>(['completed', 'partially_completed', 'failed'])
const RETRYABLE_STATUSES = new Set<SandboxRunDetail['status']>(['failed', 'partially_completed', 'cancelled'])
const MAX_IMAGE_ROWS = 200

const STATUS_LABELS: Record<SandboxExecutionStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  unavailable: 'Unavailable',
  cancelled: 'Cancelled',
}

const STATUS_TONES: Record<SandboxExecutionStatus, BadgeTone> = {
  queued: 'neutral',
  running: 'running',
  completed: 'success',
  failed: 'danger',
  unavailable: 'warning',
  cancelled: 'neutral',
}

const RUN_STATUS_LABELS: Record<SandboxRunDetail['status'], string> = {
  draft: 'Draft',
  validating: 'Validating',
  running: 'Running',
  completed: 'Completed',
  partially_completed: 'Completed with errors',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

const STAGE_MARK: Record<SandboxItemStage['status'], string> = { done: '✓', running: '→', pending: '○', failed: '✕', skipped: '–' }

function StageChain({ stages }: { stages: SandboxItemStage[] }) {
  return (
    <ol className={styles.stageChain} aria-label="Stages">
      {stages.map(stage => (
        <li key={stage.id} className={styles[`stage_${stage.status}`]}>
          <span aria-hidden="true">{STAGE_MARK[stage.status]}</span> {stage.label}
          {stage.batchGlobal && stage.status === 'running' ? ' (batch)' : ''}
        </li>
      ))}
    </ol>
  )
}

function ImageRow({
  item,
  canRetry,
  onRetryImage,
}: {
  item: SandboxRunItemState
  // The product pipeline has finished (a retry never races its own product's
  // in-flight pipeline).
  canRetry: boolean
  onRetryImage?: (productType: SandboxProductType, sku: string) => Promise<string | null>
}) {
  const stages = item.stages ?? []
  const [retryRequested, setRetryRequested] = useState(false)
  const [retryRefusal, setRetryRefusal] = useState<string | null>(null)
  const retryable = item.status === 'failed' && item.failure?.retryable === true && canRetry && !!onRetryImage

  async function handleRetry() {
    setRetryRequested(true)
    setRetryRefusal(null)
    const refusal = await onRetryImage!(item.productType, item.sku)
    // On success the engine flips this image to 'running' (the button goes
    // away with the next state event); on refusal, say why and re-enable.
    if (refusal) {
      setRetryRefusal(refusal)
      setRetryRequested(false)
    }
  }

  return (
    <li className={styles.imageRow}>
      <div className={styles.imageHead}>
        <span className={styles.imageSku}>
          {item.sku}
          {(item.attempt ?? 1) > 1 && <span className={styles.muted}> · attempt {item.attempt}</span>}
        </span>
        <Badge tone={STATUS_TONES[item.status]}>{item.status === 'running' && item.stage ? item.stage : STATUS_LABELS[item.status]}</Badge>
      </div>
      {stages.length > 0 && item.status !== 'completed' && item.status !== 'unavailable' && <StageChain stages={stages} />}
      {item.failure ? <AutomationErrorNotice error={item.failure} compact /> : item.status === 'unavailable' && item.error ? <span className={styles.muted}>{item.error}</span> : null}
      {retryable && (
        <div className={styles.retryRow}>
          <Button size="sm" variant="secondary" onClick={handleRetry} disabled={retryRequested} loading={retryRequested}>
            Retry Image
          </Button>
          {retryRefusal && <span className={styles.muted}>{retryRefusal}</span>}
        </div>
      )}
      {(item.history?.length ?? 0) > 0 && (
        <details className={styles.history}>
          <summary>Previous attempts ({item.history!.length})</summary>
          <ul>
            {item.history!.map(h => (
              <li key={h.attempt}>
                Attempt {h.attempt} failed{h.failure ? `: ${h.failure.message}` : ''} — restarted from {h.restartedFrom.replace('_', '-')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  )
}

function ProductRow({
  run,
  product,
  onRetryImage,
}: {
  run: SandboxRunDetail
  product: SandboxProductImageProgress
  onRetryImage?: (productType: SandboxProductType, sku: string) => Promise<string | null>
}) {
  const pipeline = run.pipelines.find(p => p.productType === product.productType)!
  const Glyph = SANDBOX_PRODUCT_GLYPHS[product.productType]
  const items = (run.items ?? []).filter(i => i.productType === product.productType)
  const shown = items.slice(0, MAX_IMAGE_ROWS)
  return (
    <details className={styles.productRow} open={product.failed > 0 || pipeline.status === 'failed' ? true : undefined}>
      <summary className={styles.productSummary}>
        <Glyph size={18} strokeWidth={1.5} />
        <span className={styles.pipelineName}>{SANDBOX_PRODUCT_LABELS[product.productType]}</span>
        {pipeline.status !== 'unavailable' && (
          <span className={styles.count}>
            {product.completed} / {product.total}
            {product.failed > 0 ? ` · ${product.failed} failed` : ''}
          </span>
        )}
        <Badge tone={STATUS_TONES[pipeline.status]}>{STATUS_LABELS[pipeline.status]}</Badge>
      </summary>
      {pipeline.activity && pipeline.status === 'running' && <p className={styles.activity}>{pipeline.activity}</p>}
      {pipeline.failure ? (
        <AutomationErrorNotice error={pipeline.failure} />
      ) : pipeline.status === 'unavailable' && pipeline.error ? (
        <p className={styles.muted}>{pipeline.error}</p>
      ) : null}
      {shown.length > 0 && (
        <ul className={styles.imageList}>
          {shown.map(item => (
            <ImageRow key={item.sku} item={item} canRetry={pipeline.status !== 'running' && pipeline.status !== 'queued'} onRetryImage={onRetryImage} />
          ))}
        </ul>
      )}
      {items.length > shown.length && <p className={styles.muted}>… and {items.length - shown.length} more images</p>}
    </details>
  )
}

// Live progress panel. Everything shown is derived from the persisted job
// state the engine streams (per-image stages, structured failures,
// timestamps) — never from anything computed in the view. Batch-global
// post-processing scripts are shown as "batch post-processing", never as a
// fabricated per-image percentage, and the ETA appears only when it can
// genuinely be computed.
export function SandboxRunPanel({ run, onCancel, onReview, onRetry, onRetryImage }: SandboxRunPanelProps) {
  // Also "running" while a Retry Image is in flight inside an otherwise
  // finished run — its progress streams and the clock ticks like any run's.
  const runActive = run.status === 'running' || run.status === 'validating'
  const isRunning = runActive || (run.items ?? []).some(i => i.status === 'running')
  const [now, setNow] = useState(() => Date.now())
  // Only the clock is view-owned (so elapsed time ticks between events).
  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isRunning])

  const progress = summarizeImageProgress(run, now)
  const startedMs = Date.parse(run.startedAt ?? run.createdAt)
  const endMs = !isRunning && run.finishedAt ? Date.parse(run.finishedAt) : now
  const elapsedMs = Math.max(0, endMs - startedMs)
  const finished = progress.completed + progress.failed + progress.cancelled
  const pct = progress.totalImages > 0 ? Math.round((finished / progress.totalImages) * 100) : 0

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{run.title}</span>
        <Badge tone={isRunning ? 'running' : run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral'}>
          {isRunning && !runActive ? 'Retrying image…' : RUN_STATUS_LABELS[run.status]}
        </Badge>
      </div>

      <div className={styles.overall}>
        <div className={styles.overallLine}>
          <strong>
            {progress.completed} / {progress.totalImages}
          </strong>{' '}
          images complete
          {progress.failed > 0 && <span className={styles.failedCount}> · {progress.failed} failed</span>}
          {progress.cancelled > 0 && <span> · {progress.cancelled} cancelled</span>}
          {progress.unavailable > 0 && <span> · {progress.unavailable} unavailable</span>}
        </div>
        <div
          className={styles.bar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.totalImages}
          aria-valuenow={finished}
          aria-label="Images finished"
        >
          <div className={styles.barFill} style={{ width: `${pct}%` }} />
        </div>
        <div className={styles.statRow}>
          <span>{formatDuration(elapsedMs)} elapsed</span>
          {isRunning && progress.ratePerMinute !== null && <span>· {progress.ratePerMinute.toFixed(1)} images/min</span>}
          {isRunning && progress.etaMs !== null && <span>· ~{formatDuration(progress.etaMs)} remaining (image processing)</span>}
        </div>
      </div>

      {isRunning && progress.current.length > 0 && (
        <div className={styles.current} aria-live="polite">
          {progress.current.slice(0, 4).map(c => (
            <div key={`${c.productType}:${c.sku}`}>
              <span className={styles.muted}>{SANDBOX_PRODUCT_LABELS[c.productType]}</span> <strong>{c.sku}</strong>
              {c.stage ? ` — ${c.stage}` : ''}
            </div>
          ))}
          {progress.current.length > 4 && <div className={styles.muted}>… and {progress.current.length - 4} more in progress</div>}
        </div>
      )}

      {run.failure && <AutomationErrorNotice error={run.failure} />}

      <div className={styles.pipelineList}>
        {progress.perProduct.map(product => (
          <ProductRow key={product.productType} run={run} product={product} onRetryImage={onRetryImage} />
        ))}
      </div>

      <div className={styles.actions}>
        {isRunning && (
          <Button variant="danger" onClick={onCancel} disabled={run.cancelRequested}>
            {run.cancelRequested ? 'Cancelling…' : 'Cancel Run'}
          </Button>
        )}
        {!isRunning && REVIEWABLE_STATUSES.has(run.status) && onReview && <Button onClick={onReview}>Review Results</Button>}
        {!isRunning && RETRYABLE_STATUSES.has(run.status) && onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            Retry Run
          </Button>
        )}
      </div>
    </div>
  )
}
