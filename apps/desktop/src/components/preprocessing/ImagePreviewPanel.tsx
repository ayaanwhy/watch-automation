import { BeforeAfterSlider } from './BeforeAfterSlider'
import { joinPath, toFileUrl } from '../../lib/paths'
import type { PreprocessingImageState } from '../../context/PreprocessingJobContext'
import styles from './ImagePreviewPanel.module.css'

interface ImagePreviewPanelProps {
  image: PreprocessingImageState | null
  inputDir: string
  // 'run': always shows the single original image (the "currently selected
  // image", per Phase 9D's spec — output may not exist yet for an in-flight
  // image, so there is nothing to compare against during execution).
  // 'details': once the stage has finished, a completed image becomes a
  // before/after comparison; a failed/cancelled/never-run image falls back
  // to a single preview with its status explained.
  mode: 'run' | 'details'
}

// Selecting a thumbnail opens this larger preview. While running it always
// shows the currently selected image; after completion it becomes the
// review panel (comparison for a completed image, status explanation
// otherwise) — see Phase 9D's "Current image panel" / "Before / After
// comparison" requirements.
export function ImagePreviewPanel({ image, inputDir, mode }: ImagePreviewPanelProps) {
  if (!image) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>No image selected.</div>
      </div>
    )
  }

  const originalSrc = toFileUrl(joinPath(inputDir, image.name))

  if (mode === 'details' && image.status === 'completed' && image.outputPath) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.name}>{image.name}</span>
        </div>
        <BeforeAfterSlider beforeSrc={originalSrc} afterSrc={toFileUrl(image.outputPath)} />
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
      {mode === 'details' && image.status === 'failed' && (
        <div className={styles.statusFailed}>Failed{image.error ? `: ${image.error}` : ''}</div>
      )}
      {mode === 'details' && image.status === 'cancelled' && (
        <div className={styles.statusCancelled}>Not processed — batch was cancelled first.</div>
      )}
    </div>
  )
}
