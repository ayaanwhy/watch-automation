import type { ReactNode } from 'react'
import type { AppView } from '../../types/navigation'
import { Sidebar } from './Sidebar'
import styles from './AppShell.module.css'

interface AppShellProps {
  view: AppView
  onNavigate: (view: AppView) => void
  children: ReactNode
}

// Persistent application frame: a full-height dark sidebar with permanent
// workflow shortcuts, plus a light content region. The content region is a
// full-height scroll container, so existing screens that assume they own the
// viewport render unchanged.
export function AppShell({ view, onNavigate, children }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <Sidebar view={view} onNavigate={onNavigate} />
      <main className={styles.content}>{children}</main>
    </div>
  )
}
