import type { ReactNode } from 'react'
import type { AppView, EditingProduct } from '../../types/navigation'
import { Sidebar } from './Sidebar'
import styles from './AppShell.module.css'

interface AppShellProps {
  view: AppView
  editingProduct: EditingProduct | null
  onNavigate: (view: AppView, product?: EditingProduct) => void
  children: ReactNode
}

// Persistent application frame: a full-height dark sidebar with permanent
// workflow shortcuts, plus a light content region. The content region is a
// full-height scroll container, so existing screens that assume they own the
// viewport render unchanged.
export function AppShell({ view, editingProduct, onNavigate, children }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <Sidebar view={view} editingProduct={editingProduct} onNavigate={onNavigate} />
      <main className={styles.content}>{children}</main>
    </div>
  )
}
