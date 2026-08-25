import { useState } from 'react'
import { ChevronsLeftRight } from 'lucide-react'
import { SegmentedControl } from '../ui/SegmentedControl'
import styles from './BeforeAfterSlider.module.css'

// Reverted post-Phase-13 back to the pre-13F vocabulary (Transparent /
// White / Black) — the Neutral/White/Checkerboard rename made reviewing
// transparent PNG assets against a checker pattern less direct than the
// original "Transparent" option, per explicit product direction.
export type ComparisonBackground = 'transparent' | 'white' | 'black'

// Phase 13G — Batch Details' review toolbar. 'sideBySide' shows both images
// at once, unclipped, no drag handle — some reviewers prefer it over the
// slider for spotting differences. Every Phase 13F Stage-workspace caller
// omits this prop entirely, so their rendering is byte-identical to before.
export type CompareMode = 'slider' | 'sideBySide'

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
  // Phase 13G — Batch Details' review toolbar hosts its own backdrop control
  // above the grid/preview split (so the same choice applies regardless of
  // which image is selected), and passes false here to avoid showing the
  // control twice. Every 13F Stage-workspace caller omits this (stays true,
  // unchanged — those screens have no outer toolbar to host it instead).
  showBackgroundToggle?: boolean
  compareMode?: CompareMode
  // A plain CSS scale on the image content, centered — every existing
  // caller omits this (stays 1, unchanged).
  zoom?: number
}

const BACKGROUND_OPTIONS: { value: ComparisonBackground; label: string }[] = [
  { value: 'transparent', label: 'Transparent' },
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
  showBackgroundToggle = true,
  compareMode = 'slider',
  zoom = 1,
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
  const boxClass = `${styles.box} ${styles[BACKGROUND_CLASS[background]]}`
  const zoomStyle = zoom !== 1 ? { transform: `scale(${zoom})` } : undefined

  return (
    <div className={styles.frame}>
      {showBackgroundToggle && (
        <SegmentedControl
          variant="pill"
          className={styles.backgroundToggle}
          options={BACKGROUND_OPTIONS}
          value={background}
          onChange={onBackgroundChange}
          aria-label="Preview background"
        />
      )}
      {compareMode === 'sideBySide' ? (
        <div className={styles.sideBySide}>
          <div className={boxClass}>
            <img className={styles.image} src={beforeSrc} alt={beforeLabel} draggable={false} style={zoomStyle} />
            <span className={`${styles.label} ${styles.labelLeft}`}>{beforeLabel}</span>
          </div>
          <div className={boxClass}>
            <img
              className={styles.image}
              src={afterSrcAttempt}
              alt={afterLabel}
              draggable={false}
              style={zoomStyle}
              onLoad={() => setAfterFailed(false)}
              onError={handleAfterError}
            />
            {afterFailed && <div className={styles.loadError}>Image failed to load</div>}
            <span className={`${styles.label} ${styles.labelRight}`}>{afterLabel}</span>
          </div>
        </div>
      ) : (
        <div className={boxClass}>
          <img
            className={styles.image}
            src={beforeSrc}
            alt={beforeLabel}
            draggable={false}
            style={{ clipPath: `inset(0 ${100 - percent}% 0 0)`, ...zoomStyle }}
          />
          <img
            className={styles.image}
            src={afterSrcAttempt}
            alt={afterLabel}
            draggable={false}
            style={{ clipPath: `inset(0 0 0 ${percent}%)`, ...zoomStyle }}
            onLoad={() => setAfterFailed(false)}
            onError={handleAfterError}
          />
          {afterFailed && (
            <div className={styles.loadError}>Image failed to load</div>
          )}
          <div className={styles.handle} style={{ left: `${percent}%` }} aria-hidden="true">
            <div className={styles.handleGrip}>
              <ChevronsLeftRight size={14} strokeWidth={2} className={styles.handleArrows} />
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
      )}
    </div>
  )
}
