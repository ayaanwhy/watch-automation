import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { LayoutDashboard, Layers, Settings as SettingsIcon, Search, SearchX, Clock } from 'lucide-react'
import { RingGlyph, BraceletGlyph, EarringGlyph, WatchGlyph, type IconComponent } from '../icons/ProductGlyphs'
import type { AppView, EditingProduct } from '../../types/navigation'
import type { BatchSummaryRecord } from '../../types/batch'
import styles from './CommandPalette.module.css'

interface CommandPaletteProps {
  onNavigate: (view: AppView, product?: EditingProduct) => void
  onOpenBatch: (id: string) => void
}

interface NavCommand {
  id: string
  label: string
  icon: IconComponent
  run: () => void
}

// ⌘K / Ctrl+K command palette (Phase 13C, Navigation spec) — glass overlay,
// one of the four sanctioned surfaces. Two sections: static navigation
// entries (mirrors Sidebar's own destinations) and "Open recent batch…",
// fetched from the same batch-registry:list channel Home.tsx already uses —
// no new IPC. Review-context actions (backdrop/compare toggles) the
// Navigation spec also mentions are deferred: no screen exposes that state
// yet (13G's job), so there is nothing correct to wire in here today.
export function CommandPalette({ onNavigate, onOpenBatch }: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [batches, setBatches] = useState<BatchSummaryRecord[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus restore (Phase 13I) — whatever had focus when ⌘K/Ctrl+K was
  // pressed gets it back on close, since the palette is a transient overlay
  // over the workspace, not a navigation.
  const triggerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => {
          if (!o) triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          return !o
        })
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    void window.api.invoke('batch-registry:list').then(setBatches)
    // Focus after the dialog paints — a same-tick focus() can be lost to
    // the overlay's own initial layout.
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  // Restores focus to whatever triggered the palette once it closes, rather
  // than dropping it to <body> (Phase 13I) — mirrors the native <dialog>
  // focus-restore Modal.tsx already gets for free via useNativeDialog.
  useEffect(() => {
    if (open) return
    triggerRef.current?.focus()
    triggerRef.current = null
  }, [open])

  const navCommands: NavCommand[] = useMemo(
    () => [
      { id: 'nav-home', label: 'Dashboard', icon: LayoutDashboard, run: () => onNavigate('home') },
      { id: 'nav-preprocessing', label: 'Preprocessing', icon: Layers, run: () => onNavigate('preprocessing') },
      { id: 'nav-ring', label: 'Editing — Rings', icon: RingGlyph, run: () => onNavigate('editing', 'ring') },
      { id: 'nav-bracelet', label: 'Editing — Bracelets', icon: BraceletGlyph, run: () => onNavigate('editing', 'bracelet') },
      { id: 'nav-earring', label: 'Editing — Earrings', icon: EarringGlyph, run: () => onNavigate('editing', 'earring') },
      { id: 'nav-watch', label: 'Editing — Watches', icon: WatchGlyph, run: () => onNavigate('editing', 'watch') },
      { id: 'nav-settings', label: 'Settings', icon: SettingsIcon, run: () => onNavigate('settings') },
    ],
    [onNavigate],
  )

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return navCommands
    return navCommands.filter(c => c.label.toLowerCase().includes(q))
  }, [navCommands, query])

  const filteredBatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q === '' ? batches : batches.filter(b => b.title.toLowerCase().includes(q))
    return list.slice(0, 8)
  }, [batches, query])

  const totalItems = filteredCommands.length + filteredBatches.length

  function close() {
    setOpen(false)
  }

  function runIndex(index: number) {
    if (index < filteredCommands.length) {
      filteredCommands[index].run()
    } else {
      const batch = filteredBatches[index - filteredCommands.length]
      if (batch) onOpenBatch(batch.id)
    }
    close()
  }

  function handleInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, totalItems - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (totalItems > 0) runIndex(activeIndex)
    } else if (e.key === 'Tab') {
      // Focus trap (Phase 13I) — the palette's own options are driven by
      // arrow keys via activeIndex, never real DOM focus (see CommandRow),
      // so the only thing Tab could otherwise do is leak focus into the
      // still-interactive app behind the scrim.
      e.preventDefault()
    }
  }

  if (!open) return null

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={e => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className={styles.searchRow}>
          <Search size={16} strokeWidth={1.5} className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Navigate, or open a recent batch…"
          />
        </div>
        <div className={styles.list} role="listbox">
          {filteredCommands.map((cmd, i) => (
            <CommandRow key={cmd.id} icon={cmd.icon} label={cmd.label} active={i === activeIndex} onClick={() => runIndex(i)} />
          ))}
          {filteredBatches.length > 0 && (
            <div className={styles.sectionLabel}>Recent batches</div>
          )}
          {filteredBatches.map((batch, i) => {
            const index = filteredCommands.length + i
            return (
              <CommandRow
                key={batch.id}
                icon={Clock}
                label={batch.title}
                active={index === activeIndex}
                onClick={() => runIndex(index)}
              />
            )
          })}
          {totalItems === 0 && (
            <div className={styles.empty}>
              <SearchX size={20} strokeWidth={1.5} aria-hidden="true" />
              <span>No matches.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CommandRow({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: IconComponent
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`${styles.row} ${active ? styles.rowActive : ''}`}
      role="option"
      aria-selected={active}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
      <span className={styles.rowLabel}>{label}</span>
    </button>
  )
}
