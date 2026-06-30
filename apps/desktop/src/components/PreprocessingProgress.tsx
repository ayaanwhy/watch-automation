import { useEffect, useState } from 'react'
import type { CancelPhase, PreprocessingProgressState } from '../context/PreprocessingJobContext'
import styles from './PreprocessingProgress.module.css'

interface PreprocessingProgressProps {
  progress: PreprocessingProgressState
  cancelPhase: CancelPhase
  startedAt: number | null
  onCancel: () => void
}

const INIT_STAGE_LABELS: Record<string, string> = {
  loading_birefnet: 'Loading BiRefNet…',
  loading_sam2: 'Loading SAM 2…',
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function PreprocessingProgress({
  progress,
  cancelPhase,
  startedAt,
  onCancel,
}: PreprocessingProgressProps) {
  // Local tick to keep elapsed time and the heartbeat-driven activity
  // indicator live — purely presentational, not a progress estimate.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsedMs = startedAt !== null ? now - startedAt : 0
  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
  const isActive = progress.lastHeartbeatAt !== null && now - progress.lastHeartbeatAt < 5000

  return (
    <div className={styles.panel}>
      <div className={styles.headerRow}>
        <span className={styles.title}>Processing…</span>
        <span className={styles.elapsed}>{formatElapsed(elapsedMs)}</span>
      </div>

      <div className={styles.progressBarTrack}>
        <div className={styles.progressBarFill} style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.counts}>
        {progress.completed} / {progress.total || '—'} images
      </div>

      <div className={styles.statusRow}>
        <span className={`${styles.activityDot} ${isActive ? styles.activityDotLive : ''}`} />
        <span className={styles.currentImage}>{progress.currentImage ?? 'Starting…'}</span>
        {progress.currentStage && <span className={styles.stageBadge}>{progress.currentStage}</span>}
      </div>

      {progress.initializingStage && (
        <div className={styles.initBanner}>
          {INIT_STAGE_LABELS[progress.initializingStage] ?? 'Initializing…'}
        </div>
      )}

      {cancelPhase === 'none' && (
        <button className={styles.cancelButton} onClick={onCancel}>
          Cancel
        </button>
      )}
      {cancelPhase === 'requested' && (
        <div className={styles.cancelPending}>Cancellation requested…</div>
      )}
      {cancelPhase === 'acknowledged' && (
        <div className={styles.cancelling}>
          {progress.initializingStage
            ? "Initialization can't be safely interrupted — cancelling immediately after it completes…"
            : 'Finishing current step before cancelling…'}
        </div>
      )}
    </div>
  )
}
