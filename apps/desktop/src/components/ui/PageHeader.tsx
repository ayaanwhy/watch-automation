import type { ReactNode } from 'react'
import styles from './PageHeader.module.css'

interface PageHeaderProps {
  title: string
  subtitle?: string
  /** Optional right-aligned actions (buttons, etc.). */
  actions?: ReactNode
  /** Pins the header to the top of the scrolling content region — only the
   * content beneath scrolls. The page using this must drop its own top
   * padding (the sticky header supplies it) so spacing stays identical
   * whether the header is stuck or not. */
  sticky?: boolean
}

// Consistent screen header: title + optional subtitle and right-aligned actions.
export function PageHeader({ title, subtitle, actions, sticky }: PageHeaderProps) {
  return (
    <div className={`${styles.header} ${sticky ? styles.sticky : ''}`}>
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  )
}
