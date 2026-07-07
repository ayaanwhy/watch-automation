import type { CSSProperties } from 'react'
import type { PreprocessingImageStatus } from '../../context/PreprocessingJobContext'
import styles from './ThumbnailCell.module.css'

interface ThumbnailCellProps {
  name: string
  status: PreprocessingImageStatus
  src: string
  selected: boolean
  onClick: () => void
  style?: CSSProperties
}

const STATUS_LABEL: Record<PreprocessingImageStatus, string> = {
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
export function ThumbnailCell({ name, status, src, selected, onClick, style }: ThumbnailCellProps) {
  return (
    <button
      className={`${styles.cell} ${selected ? styles.selected : ''}`}
      style={style}
      onClick={onClick}
      title={`${name} — ${STATUS_LABEL[status]}`}
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
      <span className={styles.name}>{name}</span>
    </button>
  )
}
