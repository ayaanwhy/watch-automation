import type { ReactNode } from 'react'
import { PageHeader } from '../ui/PageHeader'
import styles from './ConsoleLayout.module.css'

interface ConsoleLayoutProps {
  title: string
  subtitle?: string
  // Rendered between the header and the two-pane body — e.g. EditingSetup's
  // product selector, which applies to the whole console, not just one pane.
  headerExtra?: ReactNode
  // Left pane: the configuration form itself, unchanged per-screen logic.
  children: ReactNode
  // Right pane: built with ConsoleSummaryPanel below.
  summary: ReactNode
}

// Console archetype shell (Phase 13E, Layout Philosophy: "configure and
// launch. Two-pane: form on the left; a live summary panel on the right
// that restates every choice... and owns the primary Start action").
// Purely layout — every field's behavior, validation, and job-start logic
// stays exactly where it already lived in each screen.
export function ConsoleLayout({ title, subtitle, headerExtra, children, summary }: ConsoleLayoutProps) {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <PageHeader sticky title={title} subtitle={subtitle} />
        {headerExtra}
        <div className={styles.body}>
          <div className={styles.left}>{children}</div>
          <div className={styles.right}>{summary}</div>
        </div>
      </div>
    </div>
  )
}
