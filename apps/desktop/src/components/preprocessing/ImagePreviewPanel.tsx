import { useState } from 'react'
import { BeforeAfterSlider, type ComparisonBackground } from './BeforeAfterSlider'
import { joinPath, toFileUrl } from '../../lib/paths'
import type { PreprocessingImageState } from '../../context/PreprocessingJobContext'
import styles from './ImagePreviewPanel.module.css'

interface ImagePreviewPanelProps {
  image: PreprocessingImageState | null
  inputDir: string
  // Fullscreen review (Phase 10F) — omitted entirely where no FullscreenViewer
  // is mounted (e.g. inside the fullscreen view itself), so the expand
  // button only ever appears where it's actually actionable.
  onExpand?: () => void
}

// Selecting a thumbnail opens this larger preview. Behavior is driven purely
// by the selected image's own status — no separate run/details mode — so the
// before/after comparison becomes available the moment an image finishes,
// live during a run, not only after the whole batch completes.
export function ImagePreviewPanel({ image, inputDir, onExpand }: ImagePreviewPanelProps) {
  // Persists across images in this viewing session (a user comparing many
  // images likely wants the same background throughout); the slider position
  // itself resets per image via BeforeAfterSlider's key below instead.
  const [background, setBackground] = useState<ComparisonBackground>('transparent')

  if (!image) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>No image selected.</div>
      </div>
    )
  }

  const originalSrc = toFileUrl(joinPath(inputDir, image.name))

  if (image.status === 'completed' && image.outputPath) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.name}>{image.name}</span>
          {onExpand && (
            <button className={styles.expandButton} onClick={onExpand} aria-label="View fullscreen" title="View fullscreen">
              ⤢
            </button>
          )}
        </div>
        <BeforeAfterSlider
          key={image.name}
          beforeSrc={originalSrc}
          afterSrc={toFileUrl(image.outputPath)}
          background={background}
          onBackgroundChange={setBackground}
        />
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.name}>{image.name}</span>
      </div>
      <div className={styles.singleBox}>
        <img className={styles.singleImage} src={originalSrc} alt={image.name} draggable={false} />
      </div>
      {image.status === 'failed' && (
        <div className={styles.statusFailed}>Failed{image.error ? `: ${image.error}` : ''}</div>
      )}
      {image.status === 'cancelled' && (
        <div className={styles.statusCancelled}>Not processed — batch was cancelled first.</div>
      )}
    </div>
  )
}
