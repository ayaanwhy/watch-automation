import { useState } from 'react'
import styles from './BeforeAfterSlider.module.css'

interface BeforeAfterSliderProps {
  beforeSrc: string
  afterSrc: string
}

// Draggable before/after comparison. Both images are laid into the SAME
// object-fit:contain box regardless of their actual pixel dimensions (the
// preprocessing pipeline can upscale and reshape the source), so differing
// sizes are handled gracefully rather than assumed identical. The native
// range input drives the split — invisible but capturing all pointer and
// keyboard interaction — so dragging and arrow-key nudging work for free
// without hand-rolled pointer-event logic.
export function BeforeAfterSlider({ beforeSrc, afterSrc }: BeforeAfterSliderProps) {
  const [percent, setPercent] = useState(50)

  return (
    <div className={styles.frame}>
      <div className={styles.box}>
        <img className={styles.image} src={beforeSrc} alt="Original" draggable={false} />
        <img
          className={styles.image}
          src={afterSrc}
          alt="Processed"
          draggable={false}
          style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}
        />
        <div className={styles.handle} style={{ left: `${percent}%` }} aria-hidden="true">
          <div className={styles.handleGrip} />
        </div>
        <span className={`${styles.label} ${styles.labelLeft}`}>Original</span>
        <span className={`${styles.label} ${styles.labelRight}`}>Processed</span>
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
