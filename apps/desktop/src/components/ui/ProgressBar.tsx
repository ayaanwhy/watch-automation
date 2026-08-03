import styles from './ProgressBar.module.css'

interface ProgressBarProps {
  // Omit for an indeterminate shimmer (unknown total, e.g. waiting on a
  // subprocess to report its first event); 0-100 for a determinate fill.
  value?: number
  className?: string
  'aria-label'?: string
}

// Linear progress primitive (Phase 13B) — determinate fill or indeterminate
// shimmer, per the Component System's "progress family." Purely
// presentational: callers own polling/derivation of `value` from the real
// NDJSON progress events (wired starting 13F's Stage surfaces).
export function ProgressBar({ value, className, 'aria-label': ariaLabel }: ProgressBarProps) {
  const determinate = typeof value === 'number'
  const clamped = determinate ? Math.min(100, Math.max(0, value)) : 0

  return (
    <div
      className={[styles.track, className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={determinate ? Math.round(clamped) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {determinate ? (
        <div className={styles.fill} style={{ width: `${clamped}%` }} />
      ) : (
        <div className={styles.shimmer} />
      )}
    </div>
  )
}
