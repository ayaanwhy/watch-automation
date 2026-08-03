import { LayoutDashboard, Layers, Settings as SettingsIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AppView, EditingProduct } from '../../types/navigation'
import type { BatchDetailRecord } from '../../types/batch'
import { RingGlyph, BraceletGlyph, EarringGlyph, NecklaceGlyph, WatchGlyph, type IconComponent } from '../icons/ProductGlyphs'
import { NowRunningTile } from './NowRunningTile'
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
  // Now Running tile (Phase 13C, Decision 10) — read-only batch records
  // already tracked by App.tsx; NowRunningTile itself reads the three job
  // contexts directly (Sidebar is already their descendant).
  preprocessBatch: BatchDetailRecord | null
  editingBatch: BatchDetailRecord | null
  onOpenBatch: (id: string) => void
}

// Category placeholders under "Editing" — roadmap destinations. Watches,
// Rings, Bracelets, and Earrings are wired to the shared Editing setup
// screen (Phase 10D, Earrings added in Phase 12C), each preselecting its own
// product; the rest are intentionally visible but disabled, per the product
// vocabulary of future editing categories (distinct from the Python
// preprocessing plugin vocabulary of the same names).
interface EditingCategory {
  label: string
  product: EditingProduct | null // null = disabled placeholder, not yet navigable
  glyph: IconComponent
}

const EDITING_CATEGORIES: EditingCategory[] = [
  { label: 'Rings', product: 'ring', glyph: RingGlyph },
  { label: 'Bracelets', product: 'bracelet', glyph: BraceletGlyph },
  { label: 'Earrings', product: 'earring', glyph: EarringGlyph },
  { label: 'Necklaces', product: null, glyph: NecklaceGlyph },
  { label: 'Watches', product: 'watch', glyph: WatchGlyph },
]

// Persistent left rail. Preprocessing and Editing › Watches are permanent
// navigation destinations — pure entry points into a workflow's configuration
// screen. They carry no batch state themselves; a Batch is created only when
// the user starts real work (Run / Begin Annotation) from within that screen.
//
// Phase 13C — one of the four sanctioned glass surfaces (Decision 5);
// unicode glyphs (⌂ ◧ ⚙) replaced with lucide icons, product categories now
// use the custom glyph set (Phase 13A) on the same stroke grid. "Home"
// relabeled "Dashboard" per the Navigation spec — the underlying AppView
// value ('home') and Home.tsx's own content are unchanged; this phase only
// rebuilds the shell, not the screen (that's 13D).
export function Sidebar({ view, editingProduct, onNavigate, preprocessBatch, editingBatch, onOpenBatch }: SidebarProps) {
  return (
    <nav className={styles.sidebar} aria-label="Primary">
      <div className={styles.brand}>
        <span className={styles.brandFull}>VTO Automation</span>
        <span className={styles.brandMark} aria-hidden="true">V</span>
      </div>

      <div className={styles.group}>
        <NavButton label="Dashboard" icon={LayoutDashboard} active={view === 'home'} onClick={() => onNavigate('home')} />
        <NavButton
          label="Preprocessing"
          icon={Layers}
          // Stays highlighted while in the dedicated workspace screen too
          // (Phase 10F) — clicking it always navigates back to the listing
          // regardless of which of the two is currently showing.
          active={view === 'preprocessing' || view === 'preprocessingWorkspace'}
          onClick={() => onNavigate('preprocessing')}
        />
      </div>

      <div className={styles.sectionLabel}>Editing</div>
      <div className={styles.group}>
        {EDITING_CATEGORIES.map(cat => {
          const Glyph = cat.glyph
          return (
            <button
              key={cat.label}
              className={styles.item}
              disabled={cat.product === null}
              aria-disabled={cat.product === null || undefined}
              aria-current={cat.product !== null && view === 'editing' && editingProduct === cat.product ? 'page' : undefined}
              onClick={cat.product ? () => onNavigate('editing', cat.product as EditingProduct) : undefined}
              title={cat.product === null ? `${cat.label} — coming soon` : cat.label}
            >
              <Glyph size={18} strokeWidth={1.5} className={styles.glyph} />
              <span className={styles.label}>{cat.label}</span>
              {cat.product === null && <span className={styles.soon}>Soon</span>}
            </button>
          )
        })}
      </div>

      <div className={styles.spacer} />

      <NowRunningTile preprocessBatch={preprocessBatch} editingBatch={editingBatch} onOpenBatch={onOpenBatch} />

      <div className={styles.group}>
        <NavButton label="Settings" icon={SettingsIcon} active={view === 'settings'} onClick={() => onNavigate('settings')} />
      </div>
    </nav>
  )
}

function NavButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string
  icon: IconComponent
  active: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      className={`${styles.item} ${active ? styles.itemActive : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={label}
    >
      <Icon size={18} strokeWidth={1.5} className={styles.glyph} />
      <span className={styles.label}>{label}</span>
    </button>
  )
}
