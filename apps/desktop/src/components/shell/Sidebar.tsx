import type { AppView, EditingProduct } from '../../types/navigation'
import styles from './Sidebar.module.css'

interface SidebarProps {
  view: AppView
  // Which product the Editing screen currently shows — needed to highlight
  // the right one of Watches/Rings/Bracelets, since they all share the same
  // `view === 'editing'` (Phase 10D).
  editingProduct: EditingProduct | null
  // `product` is only meaningful when navigating to 'editing' — it preselects
  // which product the shared setup screen shows, so a sidebar shortcut never
  // makes the user pick again (Phase 10D).
  onNavigate: (view: AppView, product?: EditingProduct) => void
}

// Category placeholders under "Editing" — roadmap destinations. Watches,
// Rings, and Bracelets are wired to the shared Editing setup screen (Phase
// 10D), each preselecting its own product; the rest are intentionally
// visible but disabled, per the product vocabulary of future editing
// categories (distinct from the Python preprocessing plugin vocabulary of
// the same names).
interface EditingCategory {
  label: string
  product: EditingProduct | null // null = disabled placeholder, not yet navigable
}

const EDITING_CATEGORIES: EditingCategory[] = [
  { label: 'Rings', product: 'ring' },
  { label: 'Bracelets', product: 'bracelet' },
  { label: 'Earrings', product: null },
  { label: 'Necklaces', product: null },
  { label: 'Watches', product: 'watch' },
]

// Persistent left rail. Preprocessing and Editing › Watches are permanent
// navigation destinations — pure entry points into a workflow's configuration
// screen. They carry no batch state themselves; a Batch is created only when
// the user starts real work (Run / Begin Annotation) from within that screen.
export function Sidebar({ view, editingProduct, onNavigate }: SidebarProps) {
  return (
    <nav className={styles.sidebar} aria-label="Primary">
      <div className={styles.brand}>
        <span className={styles.brandFull}>VTO Automation</span>
        <span className={styles.brandMark} aria-hidden="true">V</span>
      </div>

      <div className={styles.group}>
        <NavButton label="Home" glyph="⌂" active={view === 'home'} onClick={() => onNavigate('home')} />
        <NavButton
          label="Preprocessing"
          glyph="◧"
          // Stays highlighted while in the dedicated workspace screen too
          // (Phase 10F) — clicking it always navigates back to the listing
          // regardless of which of the two is currently showing.
          active={view === 'preprocessing' || view === 'preprocessingWorkspace'}
          onClick={() => onNavigate('preprocessing')}
        />
      </div>

      <div className={styles.sectionLabel}>Editing</div>
      <div className={styles.group}>
        {EDITING_CATEGORIES.map(cat => (
          <button
            key={cat.label}
            className={styles.item}
            disabled={cat.product === null}
            aria-disabled={cat.product === null || undefined}
            aria-current={cat.product !== null && view === 'editing' && editingProduct === cat.product ? 'page' : undefined}
            onClick={cat.product ? () => onNavigate('editing', cat.product as EditingProduct) : undefined}
            title={cat.product === null ? `${cat.label} — coming soon` : cat.label}
          >
            <span className={styles.label}>{cat.label}</span>
            {cat.product === null && <span className={styles.soon}>Soon</span>}
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
