import { ArrowDown } from 'lucide-react'
import styles from './StageArrow.module.css'

// Thin visual connector between Universal Configuration's major sections
// (Preprocessing -> Editing -> Post Processing) — a hairline stem with a
// small chevron, restrained per the Atelier direction ("no excessive
// glow"). Purely decorative/structural; carries no state.
export function StageArrow() {
  return (
    <div className={styles.arrow} aria-hidden="true">
      <span className={styles.stem} />
      <ArrowDown size={14} strokeWidth={1.5} className={styles.chevron} />
    </div>
  )
}
