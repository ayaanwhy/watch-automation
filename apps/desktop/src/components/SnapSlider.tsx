import styles from './SnapSlider.module.css'

export interface SnapSliderOption<T extends string | number> {
  value: T
  label: string
}

interface SnapSliderProps<T extends string | number> {
  label: string
  options: SnapSliderOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}

// Generic discrete snap slider. Internally tracks an index (0…n-1) and maps
// to/from the caller's typed value. Supports keyboard navigation and click
// anywhere on the track or labels to jump to the nearest stop.
export function SnapSlider<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SnapSliderProps<T>) {
  const n = options.length
  const currentIndex = Math.max(0, options.findIndex(o => o.value === value))
  const thumbPct = n > 1 ? (currentIndex / (n - 1)) * 100 : 0

  function jumpToIndex(i: number) {
    if (disabled) return
    const clamped = Math.max(0, Math.min(n - 1, i))
    if (clamped !== currentIndex) onChange(options[clamped].value)
  }

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    if (disabled) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    jumpToIndex(Math.round(pct * (n - 1)))
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      jumpToIndex(currentIndex - 1)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      jumpToIndex(currentIndex + 1)
    }
  }

  return (
    <div className={`${styles.field} ${disabled ? styles.disabled : ''}`}>
      <span className={styles.label}>{label}</span>

      <div
        className={styles.sliderWrap}
        role="slider"
        aria-label={label}
        aria-valuenow={currentIndex}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuetext={options[currentIndex]?.label ?? String(value)}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={handleTrackClick}
        onKeyDown={handleKeyDown}
      >
        {/* Track, fill, and thumb */}
        <div className={styles.track}>
          <div className={styles.fill} style={{ width: `${thumbPct}%` }} />
          <div className={styles.thumb} style={{ left: `${thumbPct}%` }} />
        </div>

        {/* Labels row — one per stop, space-between so edges align with thumb */}
        <div className={styles.labels}>
          {options.map((opt, i) => (
            <span
              key={String(opt.value)}
              className={i === currentIndex ? `${styles.optionLabel} ${styles.activeLabel}` : styles.optionLabel}
              onClick={e => { e.stopPropagation(); jumpToIndex(i) }}
            >
              {opt.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
