import styles from './Skeleton.module.css'

type SkeletonVariant = 'text' | 'block' | 'circle'

interface SkeletonProps {
  variant?: SkeletonVariant
  width?: number | string
  height?: number | string
  className?: string
}

// Shimmer placeholder primitive (Phase 13B) — per Motion Language: "Skeletons
// only for genuinely asynchronous data (registry fetch on cold open,
// thumbnail decode) — never entrance theater." Unwired until a screen has a
// real async-load moment to cover (13D+).
export function Skeleton({ variant = 'block', width, height, className }: SkeletonProps) {
  return (
    <span
      className={[styles.skeleton, styles[variant], className].filter(Boolean).join(' ')}
      style={{ width, height }}
      aria-hidden="true"
    />
  )
}
