import type { CSSProperties } from 'react'
import { Flag, AlertTriangle } from 'lucide-react'
import styles from './ThumbnailCell.module.css'

// Defined locally (not imported from PreprocessingJobContext) so this
// component has no dependency on any one job's context — Preprocessing and
// Ring & Bracelet each define their own identically-shaped status union and
// both satisfy this structurally, keeping the two job contexts decoupled
// (Phase 10D) while still sharing the one presentational primitive.
export type ThumbnailStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'

interface ThumbnailCellProps {
  name: string
  status: ThumbnailStatus
  lowConfidence?: boolean
  needsFixing?: boolean
  // null while its thumbnail is still being generated (Item 6, post-Phase-13
  // polish — see useThumbnailCache) — rendered as a plain placeholder rather
  // than falling back to the original full-resolution file, which would
  // defeat the whole point of not decoding it for a 92px cell.
  src: string | null
  selected: boolean
  onClick: () => void
  style?: CSSProperties
}

const STATUS_LABEL: Record<ThumbnailStatus, string> = {
  pending: 'Pending',
  processing: 'Processing…',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

// A single grid cell. Every status is communicated without ever removing the
// image — pending is dimmed, processing shows an indeterminate left-to-right
// sweep (no per-image percentage exists in the wire protocol, so this is
// honestly indeterminate rather than a fabricated number). Phase 13F:
// status reads as a thin ring + corner dot rather than a color wash over
// the thumbnail (Component System: "status as a thin ring + corner dot
// (never color washes over the image), accent outline for selection, rose
// corner flag for Needs Fixing") — selection always wins the ring's color
// when both apply, since "where am I in this grid" is the more important
// signal at a glance.
export function ThumbnailCell({ name, status, lowConfidence, needsFixing, src, selected, onClick, style }: ThumbnailCellProps) {
  const title = needsFixing
    ? `${name} — ${STATUS_LABEL[status]} — flagged: needs fixing`
    : lowConfidence
    ? `${name} — ${STATUS_LABEL[status]} — low confidence, worth a closer look`
    : `${name} — ${STATUS_LABEL[status]}`
  return (
    <button
      className={`${styles.cell} ${selected ? styles.selected : ''}`}
      style={style}
      onClick={onClick}
      title={title}
      data-status={status}
    >
      {src !== null && (
        <img className={styles.image} src={src} alt="" loading="lazy" decoding="async" draggable={false} />
      )}
      {status === 'processing' && (
        <div className={styles.sweepTrack}>
          <div className={styles.sweepBar} />
        </div>
      )}
      <span className={styles.statusDot} aria-hidden="true" />
      {status === 'completed' && lowConfidence && (
        <AlertTriangle size={11} strokeWidth={2} className={`${styles.flagIcon} ${styles.flagLowConfidence}`} aria-hidden="true" />
      )}
      {status === 'completed' && needsFixing && (
        <Flag size={11} strokeWidth={2} className={`${styles.flagIcon} ${styles.flagNeedsFixing}`} aria-hidden="true" />
      )}
      <span className={styles.name}>{name}</span>
    </button>
  )
}
