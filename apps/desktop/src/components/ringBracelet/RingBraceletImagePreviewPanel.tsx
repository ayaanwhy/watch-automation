import { useState } from 'react'
import { BeforeAfterSlider, type ComparisonBackground } from '../shared/BeforeAfterSlider'
import { joinPath, toFileUrl } from '../../lib/paths'
import type { RingBraceletImageState } from '../../context/RingBraceletJobContext'
// Shares PreviewPanel's stylesheet with ImagePreviewPanel.tsx (Phase 11C) —
// same layout shape (name header, single-preview fallback, status
// messages), no parallel CSS file.
import styles from '../shared/PreviewPanel.module.css'

interface RingBraceletImagePreviewPanelProps {
  image: RingBraceletImageState | null
  inputDir: string
  // Fullscreen review (Phase 10F) — see ImagePreviewPanel's identical prop.
  onExpand?: () => void
  // Manual QA review (Phase 11.5E) — omitted entirely by callers with no
  // review concept (RingBraceletRunWorkspace's live grid), which is what
  // keeps the toggle button from rendering there; only Batch Details passes
  // this.
  onToggleNeedsFixing?: (name: string, next: boolean) => void
  // Slider labels (Phase 12C) — default to Ring & Bracelet's own "Full"/
  // "Front-Facing" wording so existing callers are unaffected; Earring's
  // callers (EarringRunWorkspace, BatchDetails) override these since its two
  // images mean something different (compare vs. shadow-composited).
  beforeLabel?: string
  afterLabel?: string
  // Low-confidence copy (Phase 12D) — default is Ring & Bracelet's own
  // shank-specific wording; Hoop's callers override it since "shank
  // boundary" doesn't describe what Hoop's detected flag actually measures.
  lowConfidenceMessage?: string
}

// Mirrors ImagePreviewPanel's structure and status-driven branching exactly,
// but compares frontFullImage against frontImage (both Ring & Bracelet
// outputs) rather than an original-vs-processed pair — there is no separate
// "original" here once an image has completed; the input *is* Universal
// Preprocessing's already-prepared transparent PNG. Reused as-is for Earring
// (Phase 12C) — see EarringImageState's doc comment for why no separate
// preview component was needed there.
export function RingBraceletImagePreviewPanel({
  image,
  inputDir,
  onExpand,
  onToggleNeedsFixing,
  beforeLabel = 'Full',
  afterLabel = 'Front-Facing',
  lowConfidenceMessage = 'No clear shank boundary found — this mask used a fallback estimate. Worth a closer look.',
}: RingBraceletImagePreviewPanelProps) {
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
          {onToggleNeedsFixing && (
            <button
              className={`${styles.needsFixingToggle} ${image.needsFixing ? styles.needsFixingToggleActive : ''}`}
              onClick={() => onToggleNeedsFixing(image.name, !image.needsFixing)}
            >
              {image.needsFixing ? '✓ Needs Fixing' : 'Mark as Needs Fixing'}
            </button>
          )}
          {onExpand && (
            <button className={styles.expandButton} onClick={onExpand} aria-label="View fullscreen" title="View fullscreen">
              ⤢
            </button>
          )}
        </div>
        <BeforeAfterSlider
          key={image.name}
          beforeSrc={toFileUrl(image.frontFullImage)}
          afterSrc={toFileUrl(image.frontImage)}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
          background={background}
          onBackgroundChange={setBackground}
        />
        {image.detected === false && (
          <div className={styles.lowConfidence}>
            <span className={styles.lowConfidenceIcon} aria-hidden="true">⚠</span>
            <span>{lowConfidenceMessage}</span>
          </div>
        )}
        {image.needsFixing === true && (
          <div className={styles.needsFixing}>
            <span className={styles.needsFixingIcon} aria-hidden="true">🚩</span>
            <span>Flagged during manual review — excluded from the batch's completed total until fixed.</span>
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
