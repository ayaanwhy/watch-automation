import type { ReactNode } from 'react'
import type { AppView, EditingProduct } from '../../types/navigation'
import type { BatchDetailRecord } from '../../types/batch'
import { Sidebar } from './Sidebar'
import { AmbientBackground } from './AmbientBackground'
import styles from './AppShell.module.css'

interface AppShellProps {
  view: AppView
  editingProduct: EditingProduct | null
  onNavigate: (view: AppView, product?: EditingProduct) => void
  // Now Running tile plumbing (Phase 13C) — passed straight through to
  // Sidebar; AppShell has no use for these itself.
  preprocessBatch: BatchDetailRecord | null
  editingBatch: BatchDetailRecord | null
  onOpenBatch: (id: string) => void
  // Freezes the ambient layer on precision screens (annotation, hoop
  // boundary editor) — App.tsx derives this; see AmbientBackground's doc
  // comment.
  freezeAmbient: boolean
  children: ReactNode
}

// Persistent application frame: a glass sidebar with permanent workflow
// shortcuts over an ambient background layer, plus an opaque content region.
// The content region is a full-height scroll container, so existing screens
// that assume they own the viewport render unchanged. Phase 13C — added the
// ambient layer and made the sidebar glass; the content region's own
// per-screen appearance is untouched (that's 13D+, screen by screen).
export function AppShell({
  view,
  editingProduct,
  onNavigate,
  preprocessBatch,
  editingBatch,
  onOpenBatch,
  freezeAmbient,
  children,
}: AppShellProps) {
  return (
    <div className={styles.shell}>
      <AmbientBackground freeze={freezeAmbient} />
      <Sidebar
        view={view}
        editingProduct={editingProduct}
        onNavigate={onNavigate}
        preprocessBatch={preprocessBatch}
        editingBatch={editingBatch}
        onOpenBatch={onOpenBatch}
      />
      <main className={styles.content}>{children}</main>
    </div>
  )
}
