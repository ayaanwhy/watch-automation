import type { ReactNode } from 'react'
import { Button } from './Button'
import type { IconComponent } from '../icons/ProductGlyphs'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  // A lucide icon component or one of components/icons/ProductGlyphs's
  // custom glyphs — both share the same size/className/currentColor
  // contract (Phase 13A), so either drops in here unchanged. IconComponent
  // (not a local ComponentType) — see its own doc comment for why a plain
  // ComponentType annotation fails on lucide's actual prop/return types
  // (13C found this the hard way; 13D's Home.tsx was this component's first
  // real consumer, which is what surfaced it here too).
  icon: IconComponent
  // One factual line, no exclamation marks (Design Language: "Microcopy is
  // factual and short").
  message: string
  actionLabel?: string
  onAction?: () => void
  children?: ReactNode
}

// Empty-state primitive (Phase 13B) — icon, one factual line, one action.
// "Every list and grid gets one" per Component System; the pixel-shimmer
// motif this section is otherwise entitled to (Decision 7: "empty states
// only") is deferred until the ambient system exists (13C) — this phase
// ships the structural/functional version. Unwired until a real list/grid
// adopts it (13D+).
export function EmptyState({ icon: Icon, message, actionLabel, onAction, children }: EmptyStateProps) {
  return (
    <div className={styles.emptyState}>
      <Icon size={32} className={styles.icon} />
      <p className={styles.message}>{message}</p>
      {actionLabel && onAction && (
        <Button variant="secondary" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  )
}
