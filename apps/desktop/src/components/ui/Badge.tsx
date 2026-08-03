import type { ReactNode } from 'react'
import styles from './Badge.module.css'

// One tone vocabulary meant to cover batch status, stage status, image
// status, low confidence, and Needs Fixing (Component System: "Badge system
// — dot + label, tones from the color system... One vocabulary for batch
// status, stage status, image status, low confidence, and Needs Fixing").
// 'review' is the rose Needs Fixing tone (Visual Direction's review-flag —
// "human judgment gets its own hue, distinct from machine failure red and
// machine doubt amber"); 'running' is the one badge tone that uses the
// accent, matching Design Language's "violet = the machine is working."
export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'review' | 'running'

interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  className?: string
}

// Introduced in Phase 13B to replace StatusChip; StatusChip itself stayed in
// place until its last two consumers (BatchCard, BatchDetails) migrated in
// Phase 13D, at which point it was deleted — see this phase's report.
export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return (
    <span className={[styles.badge, styles[tone], className].filter(Boolean).join(' ')}>
      <span className={styles.dot} aria-hidden="true" />
      <span>{children}</span>
    </span>
  )
}
