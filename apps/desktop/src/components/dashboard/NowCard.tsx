import { Layers } from 'lucide-react'
import { ProgressRing } from '../ui/ProgressRing'
import { HeartbeatPulse } from '../ui/HeartbeatPulse'
import { StageTracker } from '../ui/StageTracker'
import { WatchGlyph, RingGlyph, BraceletGlyph, EarringGlyph, type IconComponent } from '../icons/ProductGlyphs'
import { estimateEta, formatEta, formatThroughput } from '../../lib/eta'
import { buildStageSegments } from '../../lib/pipelineStages'
import type { ProgressState } from '../../context/useSubprocessJob'
import styles from './NowCard.module.css'

export type NowCardKind = 'preprocessing' | 'ring' | 'bracelet' | 'earring'

const GLYPHS: Record<NowCardKind, IconComponent> = {
  preprocessing: Layers,
  ring: RingGlyph,
  bracelet: BraceletGlyph,
  earring: EarringGlyph,
}

interface NowCardProps {
  kind: NowCardKind
  title: string
  progress: ProgressState
  startedAt: number | null
  onOpen: () => void
}

// Full-size Now-zone card (Phase 13D Dashboard, per Information Architecture:
// "live cards for running batches: product glyph, title, current image
// thumbnail, mini stage tracker, progress ring, ETA, throughput"). The
// per-image stage tracker only renders for Preprocessing — see
// lib/pipelineStages.ts's own comment for why Ring/Bracelet/Earring don't
// have an equivalent 5-step breakdown to show. Watch has no subprocess job
// context (its own workflow is interactive annotation, not a background
// batch), so it never appears in the Now zone.
export function NowCard({ kind, title, progress, startedAt, onOpen }: NowCardProps) {
  const Glyph = GLYPHS[kind]
  const percent = progress.total > 0 ? (progress.completed / progress.total) * 100 : undefined
  const { etaMs, throughputPerMin } = estimateEta(progress.completed, progress.total, startedAt)
  const heartbeatRecent = progress.lastHeartbeatAt !== null && Date.now() - progress.lastHeartbeatAt < 15000

  return (
    <button className={styles.card} onClick={onOpen}>
      <div className={styles.top}>
        <span className={styles.glyphSlot}>
          <ProgressRing value={percent} size={36} strokeWidth={3} className={styles.ring} />
          <Glyph size={16} strokeWidth={1.5} className={styles.glyph} />
        </span>
        <span className={styles.titleBlock}>
          <span className={styles.title}>{title}</span>
          <span className={styles.currentImage}>
            {progress.currentImage ?? (progress.initializingStage ? 'Preparing…' : 'Starting…')}
          </span>
        </span>
        {heartbeatRecent && <HeartbeatPulse label="Working" className={styles.heartbeat} />}
      </div>

      {kind === 'preprocessing' && (
        <StageTracker segments={buildStageSegments(progress.currentStage)} className={styles.tracker} />
      )}

      <div className={`${styles.footer} tabular-nums`}>
        <span>{progress.completed}/{progress.total}</span>
        <span>{formatThroughput(throughputPerMin)}</span>
        <span>{formatEta(etaMs)}</span>
      </div>
    </button>
  )
}
