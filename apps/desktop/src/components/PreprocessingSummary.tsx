import { useEffect, useState } from 'react'
import type { PreprocessDonePayload, PrepareProgressPayload } from '../types/ipc'
import styles from './PreprocessingSummary.module.css'

interface PreprocessingSummaryProps {
  donePayload: PreprocessDonePayload | null
  fatalError: string | null
  onReset: () => void
  onContinueToWatchProcessing?: () => Promise<{ ok: boolean; error?: string }>
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

export function PreprocessingSummary({ donePayload, fatalError, onReset, onContinueToWatchProcessing }: PreprocessingSummaryProps) {
  const [preparing, setPreparing] = useState(false)
  const [prepareProgress, setPrepareProgress] = useState<PrepareProgressPayload | null>(null)
  const [prepareError, setPrepareError] = useState<string | null>(null)

  // Only subscribed while a prepare step is actually in flight — this is a
  // single-shot operation triggered by one button click, so there is no
  // jobId to key events on (unlike the preprocess:event stream).
  useEffect(() => {
    if (!preparing) return
    const off = window.api.on('preprocess:prepare-progress', (payload: PrepareProgressPayload) => {
      setPrepareProgress(payload)
    })
    return off
  }, [preparing])

  if (!donePayload) return null

  const hasIssue = donePayload.spawnError !== undefined || fatalError !== null || donePayload.failed > 0
  const variant = hasIssue || donePayload.cancelledByUser ? styles.summaryWarn : styles.summaryOk

  async function handleContinueClick() {
    if (!onContinueToWatchProcessing) return
    setPreparing(true)
    setPrepareProgress(null)
    setPrepareError(null)
    const result = await onContinueToWatchProcessing()
    if (!result.ok) {
      setPreparing(false)
      setPrepareError(result.error ?? 'Failed to prepare images for Watch Processing.')
    }
    // On success the parent navigates away and this component unmounts —
    // no need to reset `preparing` here.
  }

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

      {prepareError && <div className={styles.errorRow}>{prepareError}</div>}

      <div className={styles.actions}>
        <button className={styles.resetButton} onClick={onReset} disabled={preparing}>
          Run another batch
        </button>
        {onContinueToWatchProcessing && donePayload.succeeded > 0 && !donePayload.spawnError && (
          <button className={styles.continueButton} onClick={handleContinueClick} disabled={preparing}>
            {preparing
              ? prepareProgress
                ? `Preparing… (${prepareProgress.completed}/${prepareProgress.total})`
                : 'Preparing…'
              : 'Continue to Watch Processing →'}
          </button>
        )}
      </div>
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
