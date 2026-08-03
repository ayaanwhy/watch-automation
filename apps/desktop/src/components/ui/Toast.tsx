import { CheckCircle2, XCircle, X } from 'lucide-react'
import styles from './Toast.module.css'

export type ToastTone = 'default' | 'success' | 'danger'

export interface ToastData {
  id: string
  tone?: ToastTone
  title: string
  description?: string
  // Rendered as a plain text action (e.g. "click → Batch Details" per the
  // Navigation spec) — the caller owns navigation, this just fires it.
  onAction?: () => void
  actionLabel?: string
}

interface ToastProps {
  toast: ToastData
  onDismiss: (id: string) => void
}

// Single toast surface (Phase 13B) — one of the four sanctioned glass
// surfaces (Decision 5). Stacking/auto-dismiss/positioning live in
// ToastHost; this is purely the visual. Unwired until 13C mounts a
// ToastHost and wires job-completion events into it.
export function Toast({ toast, onDismiss }: ToastProps) {
  const { id, tone = 'default', title, description, onAction, actionLabel } = toast
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' ? XCircle : null

  return (
    <div className={`${styles.toast} ${styles[tone]}`} role="status">
      {Icon && <Icon size={18} strokeWidth={1.5} className={styles.icon} aria-hidden="true" />}
      <div className={styles.body}>
        <span className={styles.title}>{title}</span>
        {description && <span className={styles.description}>{description}</span>}
        {onAction && actionLabel && (
          <button className={styles.action} onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
      <button className={styles.dismiss} onClick={() => onDismiss(id)} aria-label="Dismiss">
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  )
}
