import { useEffect, useState } from 'react'
import type { CancelPhase, PreprocessingProgressState } from '../context/PreprocessingJobContext'
import { Button } from './ui/Button'
import { ProgressBar } from './ui/ProgressBar'
import { StageTracker } from './ui/StageTracker'
import { HeartbeatPulse } from './ui/HeartbeatPulse'
import { buildStageSegments } from '../lib/pipelineStages'
import { estimateEta, formatEta, formatThroughput } from '../lib/eta'
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

// The run workspace's rich sidebar panel (Phase 13F, Screen-by-Screen
// Direction: "right rail: five-segment stage tracker, heartbeat pulse,
// rolling ETA... throughput"). Same props/callers as before — Preprocessing,
// Ring & Bracelet, and Earring's run workspaces all pass this straight
// through unchanged; only Preprocessing ever populates currentStage/
// initializingStage, so the stage tracker and init banner simply never
// render for the other two (nothing new — the same graceful-absence
// behavior this component already had).
export function PreprocessingProgress({
  progress,
  cancelPhase,
  startedAt,
  onCancel,
}: PreprocessingProgressProps) {
  // Local tick to keep elapsed time, the heartbeat window, and rolling
  // ETA/throughput live — purely presentational, not a progress estimate of
  // its own.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsedMs = startedAt !== null ? now - startedAt : 0
  const percent = progress.total > 0 ? (progress.completed / progress.total) * 100 : undefined
  const isActive = progress.lastHeartbeatAt !== null && now - progress.lastHeartbeatAt < 5000
  const { etaMs, throughputPerMin } = estimateEta(progress.completed, progress.total, startedAt, now)
  const showTracker = progress.currentStage !== null

  const cancelling = cancelPhase === 'requested' || cancelPhase === 'acknowledged'
  const cancelLabel =
    cancelPhase === 'requested'
      ? 'Cancellation requested…'
      : cancelPhase === 'acknowledged'
        ? progress.initializingStage
          ? 'Finishing initialization…'
          : 'Finishing current stage…'
        : 'Cancel'
  // Encodes the no-hard-kill GPU constraint into UX language instead of
  // leaving the disabled/loading button looking unresponsive (Screen-by-
  // Screen Direction: "press → button morphs... with the cooperative-cancel
  // explanation on hover").
  const cancelTitle = cancelling
    ? "Processing can't be safely interrupted mid-image — the run stops at the next safe checkpoint, not immediately."
    : undefined

  return (
    <div className={styles.panel}>
      <div className={styles.headerRow}>
        <span className={styles.title}>Processing…</span>
        <span className={`${styles.elapsed} tabular-nums`}>{formatElapsed(elapsedMs)}</span>
      </div>

      <ProgressBar value={percent} aria-label="Batch progress" />
      <div className={`${styles.counts} tabular-nums`}>
        {progress.completed} / {progress.total || '—'} images
      </div>

      <div className={styles.statusRow}>
        {isActive ? <HeartbeatPulse label="Working" /> : <span className={styles.idleDot} aria-hidden="true" />}
        <span className={styles.currentImage}>{progress.currentImage ?? 'Starting…'}</span>
      </div>

      {showTracker && <StageTracker segments={buildStageSegments(progress.currentStage)} className={styles.tracker} />}

      {(etaMs !== null || throughputPerMin !== null) && (
        <div className={`${styles.metrics} tabular-nums`}>
          <span>{formatThroughput(throughputPerMin)}</span>
          <span>{formatEta(etaMs)}</span>
        </div>
      )}

      {progress.initializingStage && (
        <div className={styles.initBanner}>
          {INIT_STAGE_LABELS[progress.initializingStage] ?? 'Initializing…'}
        </div>
      )}

      <Button
        variant="danger"
        size="sm"
        onClick={onCancel}
        loading={cancelling}
        title={cancelTitle}
        className={styles.cancelButton}
      >
        {cancelLabel}
      </Button>
    </div>
  )
}
