import type { ReactNode } from 'react'
import styles from './Panel.module.css'

interface PanelProps {
  children: ReactNode
  className?: string
}

// Neutral raised surface used to group related content on light screens.
export function Panel({ children, className }: PanelProps) {
  return <div className={[styles.panel, className].filter(Boolean).join(' ')}>{children}</div>
}
