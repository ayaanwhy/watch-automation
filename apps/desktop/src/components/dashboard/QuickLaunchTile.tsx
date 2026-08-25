import type { IconComponent } from '../icons/ProductGlyphs'
import styles from './QuickLaunchTile.module.css'

interface QuickLaunchTileProps {
  icon: IconComponent
  label: string
  description: string
  onClick: () => void
}

// Dashboard quick-launch tile (Phase 13D, Decision 14: "No unified 'New
// Batch' funnel... quick-launch tiles navigating to the consoles"). Replaces
// Home's old modal-based "New Batch" flow — clicking navigates straight to
// the matching console with a blank title and default Production mode,
// exactly what a sidebar shortcut already does today.
export function QuickLaunchTile({ icon: Icon, label, description, onClick }: QuickLaunchTileProps) {
  return (
    <button className={styles.tile} onClick={onClick}>
      <Icon size={20} strokeWidth={1.5} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        <span className={styles.description}>{description}</span>
      </span>
    </button>
  )
}
