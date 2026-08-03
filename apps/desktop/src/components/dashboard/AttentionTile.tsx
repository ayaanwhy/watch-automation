import type { IconComponent } from '../icons/ProductGlyphs'
import styles from './AttentionTile.module.css'

interface AttentionTileProps {
  icon: IconComponent
  label: string
  value: number
  detail?: string
  tone?: 'neutral' | 'review' | 'running'
  onClick?: () => void
}

// One stat tile in the Dashboard's Attention row (Phase 13D — Information
// Architecture: "four stat tiles, each a filter onto the list below").
// Clicking applies the matching filter to the Recent batches library below,
// via onClick (Home owns what "matching" means for each tile).
export function AttentionTile({ icon: Icon, label, value, detail, tone = 'neutral', onClick }: AttentionTileProps) {
  const El = onClick ? 'button' : 'div'
  return (
    <El className={`${styles.tile} ${styles[tone]}`} onClick={onClick}>
      <Icon size={18} strokeWidth={1.5} className={styles.icon} aria-hidden="true" />
      <span className={styles.body}>
        <span className={`${styles.value} tabular-nums`}>{value}</span>
        <span className={styles.label}>{label}</span>
        {detail && <span className={styles.detail}>{detail}</span>}
      </span>
    </El>
  )
}
