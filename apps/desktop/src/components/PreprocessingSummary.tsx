import type { PreprocessDonePayload } from '../types/ipc'
import styles from './PreprocessingSummary.module.css'

interface PreprocessingSummaryProps {
  donePayload: PreprocessDonePayload | null
  fatalError: string | null
  onReset: () => void
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

export function PreprocessingSummary({ donePayload, fatalError, onReset }: PreprocessingSummaryProps) {
  if (!donePayload) return null

  const hasIssue = donePayload.spawnError !== undefined || fatalError !== null || donePayload.failed > 0
  const variant = hasIssue || donePayload.cancelledByUser ? styles.summaryWarn : styles.summaryOk

  return (
    <div className={`${styles.summary} ${variant}`}>
      <div className={styles.summaryTitle}>
        {donePayload.cancelledByUser ? 'Cancelled' : 'Batch Complete'}
      </div>

      {(donePayload.spawnError || fatalError) && (
        <div className={styles.errorRow}>
          {donePayload.spawnError ? 'Failed to start the preprocessing process.' : fatalError}
        </div>
      )}

      <div className={styles.statGrid}>
        <StatRow label="Total images" value={donePayload.succeeded + donePayload.failed} />
        <StatRow label="Succeeded" value={donePayload.succeeded} accent="ok" />
        {donePayload.failed > 0 && <StatRow label="Failed" value={donePayload.failed} accent="warn" />}
        {donePayload.cancelledByUser && <StatRow label="Cancelled by user" value="yes" accent="warn" />}
        <StatRow label="Runtime" value={formatDuration(donePayload.totalDurationMs)} />
      </div>

      <button className={styles.resetButton} onClick={onReset}>
        Run another batch
      </button>
    </div>
  )
}

function StatRow({
  label,
  value,
  accent,
}: {
  label: string
  value: number | string
  accent?: 'ok' | 'warn'
}) {
  return (
    <div className={styles.statRow}>
      <span className={styles.statLabel}>{label}</span>
      <span
        className={[
          styles.statValue,
          accent === 'ok' ? styles.statOk : '',
          accent === 'warn' ? styles.statWarn : '',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}
