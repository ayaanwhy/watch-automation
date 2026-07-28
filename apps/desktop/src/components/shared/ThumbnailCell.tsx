import type { CSSProperties } from 'react'
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
  src: string
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
// honestly indeterminate rather than a fabricated number), completed clears
// to full visibility with a check badge, failed/cancelled keep the thumbnail
// visible under a tinted overlay with a status badge.
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
      <img className={styles.image} src={src} alt="" loading="lazy" decoding="async" draggable={false} />
      <div className={styles.overlay} aria-hidden="true" />
      {status === 'processing' && (
        <div className={styles.sweepTrack}>
          <div className={styles.sweepBar} />
        </div>
      )}
      {status === 'completed' && <span className={`${styles.badge} ${styles.badgeOk}`}>✓</span>}
      {status === 'failed' && <span className={`${styles.badge} ${styles.badgeErr}`}>!</span>}
      {status === 'cancelled' && <span className={`${styles.badge} ${styles.badgeWarn}`}>·</span>}
      {status === 'completed' && lowConfidence && (
        <span className={`${styles.badge} ${styles.badgeLowConfidence}`} aria-hidden="true">⚠</span>
      )}
      {status === 'completed' && needsFixing && (
        <span className={`${styles.badge} ${styles.badgeNeedsFixing}`} aria-hidden="true">🚩</span>
      )}
      <span className={styles.name}>{name}</span>
    </button>
  )
}
