import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import styles from './ConsoleSummaryPanel.module.css'

export interface ConsoleSummaryItem {
  label: string
  value: string
}

interface ConsoleSummaryPanelProps {
  // Restates every choice made in the left pane — e.g. "42 images",
  // "Background Removal + Upscaling", "Balanced v3", "Production" (Layout
  // Philosophy's own example). Pure display; the left pane's fields remain
  // the only place these are actually edited.
  items: ConsoleSummaryItem[]
  onStart: () => void
  startLabel?: string
  starting?: boolean
  canStart: boolean
  error?: string | null
  // Extra content between the item list and the Start button — e.g.
  // EarringFields' match-summary warnings, which are specific enough to
  // that screen that they don't belong in the generic item list.
  children?: ReactNode
  // Watch's console (post-Phase-13) — an existing saved session means the
  // primary action is really a Resume/Start Fresh choice, not a single
  // Start button; that pair renders as `children` instead, in place of the
  // button this hides. Every other caller omits this (stays visible,
  // unchanged).
  hideStartButton?: boolean
}

// The Console archetype's right pane (Phase 13E) — "owns the primary Start
// action." Reuses Button's loading state (Phase 13B) instead of the old
// "Starting…" label-swap pattern each screen used to hand-roll.
export function ConsoleSummaryPanel({
  items,
  onStart,
  startLabel = 'Start',
  starting = false,
  canStart,
  error,
  children,
  hideStartButton = false,
}: ConsoleSummaryPanelProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>Summary</div>
      {items.length > 0 && (
        <ul className={styles.itemList}>
          {items.map(item => (
            <li key={item.label} className={styles.item}>
              <span className={styles.itemLabel}>{item.label}</span>
              <span className={styles.itemValue}>{item.value}</span>
            </li>
          ))}
        </ul>
      )}
      {children}
      {error && <div className={styles.errorBanner}>{error}</div>}
      {!hideStartButton && (
        <Button onClick={onStart} disabled={!canStart || starting} loading={starting} className={styles.startButton}>
          {startLabel}
        </Button>
      )}
    </div>
  )
}
