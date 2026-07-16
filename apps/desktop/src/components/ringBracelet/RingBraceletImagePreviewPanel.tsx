import { useState } from 'react'
import { BeforeAfterSlider, type ComparisonBackground } from '../preprocessing/BeforeAfterSlider'
import { joinPath, toFileUrl } from '../../lib/paths'
import type { RingBraceletImageState } from '../../context/RingBraceletJobContext'
// Reuses ImagePreviewPanel's stylesheet directly — same layout shape (name
// header, single-preview fallback, status messages), no parallel CSS file.
import styles from '../preprocessing/ImagePreviewPanel.module.css'

interface RingBraceletImagePreviewPanelProps {
  image: RingBraceletImageState | null
  inputDir: string
}

// Mirrors ImagePreviewPanel's structure and status-driven branching exactly,
// but compares frontFullImage against frontImage (both Ring & Bracelet
// outputs) rather than an original-vs-processed pair — there is no separate
// "original" here once an image has completed; the input *is* Universal
// Preprocessing's already-prepared transparent PNG.
export function RingBraceletImagePreviewPanel({ image, inputDir }: RingBraceletImagePreviewPanelProps) {
  const [background, setBackground] = useState<ComparisonBackground>('transparent')

  if (!image) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>No image selected.</div>
      </div>
    )
  }

  const inputSrc = toFileUrl(joinPath(inputDir, image.name))

  if (image.status === 'completed' && image.frontFullImage && image.frontImage) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.name}>{image.name}</span>
        </div>
        <BeforeAfterSlider
          key={image.name}
          beforeSrc={toFileUrl(image.frontFullImage)}
          afterSrc={toFileUrl(image.frontImage)}
          beforeLabel="Full"
          afterLabel="Front-Facing"
          background={background}
          onBackgroundChange={setBackground}
        />
        {image.detected === false && (
          <div className={styles.lowConfidence}>
            ⚠ No clear shank boundary found — this mask used a fallback estimate. Worth a closer look.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.name}>{image.name}</span>
      </div>
      <div className={styles.singleBox}>
        <img className={styles.singleImage} src={inputSrc} alt={image.name} draggable={false} />
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
