import type { ReactNode } from 'react'
import styles from './Card.module.css'

interface CardProps {
  children: ReactNode
  /** When set, the card renders as a button and is keyboard/click actionable. */
  onClick?: () => void
  className?: string
  'aria-label'?: string
}

// Surface container primitive. Renders as a static panel by default, or an
// interactive button when onClick is provided (used for the Home module cards).
export function Card({ children, onClick, className, ...rest }: CardProps) {
  const classes = [styles.card, onClick ? styles.interactive : '', className]
    .filter(Boolean)
    .join(' ')

  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} {...rest}>
        {children}
      </button>
    )
  }
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  )
}
