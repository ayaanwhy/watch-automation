import styles from './ProgressRing.module.css'

interface ProgressRingProps {
  // Omit for an indeterminate spin (batch cards while waiting for the first
  // progress event); 0-100 for a determinate arc.
  value?: number
  size?: number
  strokeWidth?: number
  className?: string
  'aria-label'?: string
}

// Radial progress primitive (Phase 13B) — batch cards, the Now Running tile
// (both 13D/13C consumers). Purely presentational, same determinate/
// indeterminate contract as ProgressBar.
export function ProgressRing({ value, size = 32, strokeWidth = 3, className, 'aria-label': ariaLabel }: ProgressRingProps) {
  const determinate = typeof value === 'number'
  const clamped = determinate ? Math.min(100, Math.max(0, value)) : 0
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - clamped / 100)

  return (
    <svg
      className={[styles.ring, determinate ? '' : styles.indeterminate, className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={determinate ? Math.round(clamped) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <circle className={styles.track} cx={size / 2} cy={size / 2} r={radius} strokeWidth={strokeWidth} fill="none" />
      <circle
        className={styles.fill}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={determinate ? circumference : circumference * 0.28}
        strokeDashoffset={determinate ? offset : 0}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}
