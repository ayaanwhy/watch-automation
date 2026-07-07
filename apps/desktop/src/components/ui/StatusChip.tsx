import type { ReactNode } from 'react'
import styles from './StatusChip.module.css'

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'running'

interface StatusChipProps {
  tone?: ChipTone
  children: ReactNode
  className?: string
}

// Canonical status pill. Defines the app's status colors in one place so
// every "running / completed / failed / cancelled" indicator stays consistent
// (heavier use arrives with batch cards in Phase 9B).
export function StatusChip({ tone = 'neutral', children, className }: StatusChipProps) {
  return (
    <span className={[styles.chip, styles[tone], className].filter(Boolean).join(' ')}>
      {children}
    </span>
  )
}
