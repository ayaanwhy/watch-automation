import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  // Phase 13B — shows an inline spinner and forces disabled/aria-busy, so
  // callers stop hand-rolling "Starting…" label swaps per the Component
  // System's "loading state with inline spinner" direction. Children stay
  // as-is; the spinner is additive, not a label replacement.
  loading?: boolean
}

function Spinner() {
  return (
    <svg className={styles.spinner} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// Shared button primitive. Replaces the per-screen bespoke button styles
// (validate/begin/start/reset/continue/cancel) with one variant-driven
// control, rebuilt on the Atelier tokens (Phase 13B) — matte solid accent
// primary, hairline secondary, transparent ghost/danger, hover 100ms, press
// scale-to-0.98 spring. `size="icon"` is new: a square icon-only affordance
// (close buttons, folder-open) — pass a single icon child and your own
// aria-label.
export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  loading = false,
  disabled,
  children,
  ...rest
}: ButtonProps & { children?: ReactNode }) {
  const classes = [styles.button, styles[variant], styles[size], loading ? styles.loading : '', className]
    .filter(Boolean)
    .join(' ')
  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  )
}
