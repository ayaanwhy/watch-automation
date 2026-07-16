import { useState } from 'react'
import styles from './BeforeAfterSlider.module.css'

export type ComparisonBackground = 'transparent' | 'white' | 'black'

interface BeforeAfterSliderProps {
  beforeSrc: string
  afterSrc: string
  background: ComparisonBackground
  onBackgroundChange: (background: ComparisonBackground) => void
  // Defaults preserve Preprocessing's existing original/processed framing;
  // Ring & Bracelet (Phase 10D) relabels these to describe its own asset
  // pair (frontFullImage/frontImage) without needing a separate component.
  beforeLabel?: string
  afterLabel?: string
}

const BACKGROUND_OPTIONS: { value: ComparisonBackground; label: string }[] = [
  { value: 'transparent', label: 'Transparency' },
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
]

const BACKGROUND_CLASS: Record<ComparisonBackground, string> = {
  transparent: 'bgTransparent',
  white: 'bgWhite',
  black: 'bgBlack',
}

// Draggable before/after comparison. Both images are laid into the SAME
// object-fit:contain box regardless of their actual pixel dimensions (the
// preprocessing pipeline can upscale and reshape the source), so differing
// sizes are handled gracefully rather than assumed identical. The native
// range input drives the split — invisible but capturing all pointer and
// keyboard interaction — so dragging and arrow-key nudging work for free
// without hand-rolled pointer-event logic.
//
// Both images carry complementary clip-paths — "before" visible on
// [0%, percent], "after" visible on [percent%, 100%] — so exactly one of
// them is ever rendered at a given point, never both stacked. This matters
// because "after" (a background-removed PNG) is typically majority
// transparent: clipping only "after" while leaving "before" fully
// unclipped underneath let "before" bleed straight through "after"'s
// transparent regions everywhere, not just outside the reveal — the two
// images visually blended instead of one replacing the other (9E hotfix).
const AFTER_LOAD_MAX_RETRIES = 5
const AFTER_LOAD_RETRY_MS = 400

export function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  background,
  onBackgroundChange,
  beforeLabel = 'Original',
  afterLabel = 'Processed',
}: BeforeAfterSliderProps) {
  const [percent, setPercent] = useState(50)
  // The processed file is written by a separate Python process moments
  // before this component ever tries to load it — on some drives (observed
  // on an external USB SSD) the write is complete but the file isn't yet
  // visible to a second process's file loader for a brief window. A bounded
  // retry (not a longer initial delay) handles that transient race without
  // masking a genuinely missing file, which still settles into afterFailed.
  const [afterRetry, setAfterRetry] = useState(0)
  const [afterFailed, setAfterFailed] = useState(false)

  function handleAfterError() {
    if (afterRetry < AFTER_LOAD_MAX_RETRIES) {
      setTimeout(() => setAfterRetry(afterRetry + 1), AFTER_LOAD_RETRY_MS)
    } else {
      setAfterFailed(true)
    }
  }

  // Cache-busts each retry — re-requesting the exact same file:// URL after
  // a failed load can otherwise resolve from the browser's negative cache
  // instead of re-checking disk.
  const afterSrcAttempt = afterRetry === 0 ? afterSrc : `${afterSrc}?retry=${afterRetry}`

  return (
    <div className={styles.frame}>
      <div className={styles.backgroundToggle} role="group" aria-label="Preview background">
        {BACKGROUND_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`${styles.bgOption} ${background === opt.value ? styles.bgOptionActive : ''}`}
            onClick={() => onBackgroundChange(opt.value)}
            aria-pressed={background === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className={`${styles.box} ${styles[BACKGROUND_CLASS[background]]}`}>
        <img
          className={styles.image}
          src={beforeSrc}
          alt={beforeLabel}
          draggable={false}
          style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}
        />
        <img
          className={styles.image}
          src={afterSrcAttempt}
          alt={afterLabel}
          draggable={false}
          style={{ clipPath: `inset(0 0 0 ${percent}%)` }}
          onLoad={() => setAfterFailed(false)}
          onError={handleAfterError}
        />
        {afterFailed && (
          <div className={styles.loadError}>Image failed to load</div>
        )}
        <div className={styles.handle} style={{ left: `${percent}%` }} aria-hidden="true">
          <div className={styles.handleGrip}>
            <span className={styles.handleArrows}>◂▸</span>
          </div>
        </div>
        <span className={`${styles.label} ${styles.labelLeft}`}>{beforeLabel}</span>
        <span className={`${styles.label} ${styles.labelRight}`}>{afterLabel}</span>
        <input
          className={styles.rangeInput}
          type="range"
          min={0}
          max={100}
          value={percent}
          onChange={e => setPercent(Number(e.target.value))}
          aria-label="Comparison slider"
        />
      </div>
    </div>
  )
}
