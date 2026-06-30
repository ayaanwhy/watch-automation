import { useEffect, useState } from 'react'
import type { PreprocessingProgressState } from '../hooks/usePreprocessingJob'
import styles from './PreprocessingProgress.module.css'

interface PreprocessingProgressProps {
  progress: PreprocessingProgressState
  cancelRequested: boolean
  startedAt: number | null
  onCancel: () => void
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function PreprocessingProgress({
  progress,
  cancelRequested,
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

      {cancelRequested ? (
        <div className={styles.cancelling}>Cancelling — finishing current step…</div>
      ) : (
        <button className={styles.cancelButton} onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  )
}
