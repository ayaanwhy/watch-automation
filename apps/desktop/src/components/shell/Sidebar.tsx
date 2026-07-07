import type { AppView } from '../../types/navigation'
import styles from './Sidebar.module.css'

interface SidebarProps {
  view: AppView
  onNavigate: (view: AppView) => void
}

// Category placeholders under "Editing" — roadmap destinations. Only Watches
// is wired to a real workflow today; the rest are intentionally visible but
// disabled, per the product vocabulary of future editing categories (distinct
// from the Python preprocessing plugin vocabulary of the same names).
interface EditingCategory {
  label: string
  view: AppView | null // null = disabled placeholder, not yet navigable
}

const EDITING_CATEGORIES: EditingCategory[] = [
  { label: 'Rings', view: null },
  { label: 'Bracelets', view: null },
  { label: 'Earrings', view: null },
  { label: 'Necklaces', view: null },
  { label: 'Watches', view: 'watch' },
]

// Persistent left rail. Preprocessing and Editing › Watches are permanent
// navigation destinations — pure entry points into a workflow's configuration
// screen. They carry no batch state themselves; a Batch is created only when
// the user starts real work (Run / Begin Annotation) from within that screen.
export function Sidebar({ view, onNavigate }: SidebarProps) {
  return (
    <nav className={styles.sidebar} aria-label="Primary">
      <div className={styles.brand}>
        <span className={styles.brandFull}>Watch Automation</span>
        <span className={styles.brandMark} aria-hidden="true">W</span>
      </div>

      <div className={styles.group}>
        <NavButton label="Home" glyph="⌂" active={view === 'home'} onClick={() => onNavigate('home')} />
        <NavButton
          label="Preprocessing"
          glyph="◧"
          active={view === 'preprocessing'}
          onClick={() => onNavigate('preprocessing')}
        />
      </div>

      <div className={styles.sectionLabel}>Editing</div>
      <div className={styles.group}>
        {EDITING_CATEGORIES.map(cat => (
          <button
            key={cat.label}
            className={styles.item}
            disabled={cat.view === null}
            aria-disabled={cat.view === null || undefined}
            aria-current={cat.view !== null && view === cat.view ? 'page' : undefined}
            onClick={cat.view ? () => onNavigate(cat.view as AppView) : undefined}
            title={cat.view === null ? `${cat.label} — coming soon` : cat.label}
          >
            <span className={styles.label}>{cat.label}</span>
            {cat.view === null && <span className={styles.soon}>Soon</span>}
          </button>
        ))}
      </div>

      <div className={styles.spacer} />

      <div className={styles.group}>
        <NavButton label="Settings" glyph="⚙" active={view === 'settings'} onClick={() => onNavigate('settings')} />
      </div>
    </nav>
  )
}

function NavButton({
  label,
  glyph,
  active,
  onClick,
}: {
  label: string
  glyph: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`${styles.item} ${active ? styles.itemActive : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={label}
    >
      <span className={styles.glyph} aria-hidden="true">{glyph}</span>
      <span className={styles.label}>{label}</span>
    </button>
  )
}
