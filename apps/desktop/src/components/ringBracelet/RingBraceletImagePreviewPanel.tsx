import { useState } from 'react'
import { Maximize2, AlertTriangle, Flag } from 'lucide-react'
import { BeforeAfterSlider, type ComparisonBackground, type CompareMode } from '../shared/BeforeAfterSlider'
import { useBackdropCycle } from '../../hooks/useBackdropCycle'
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
  // Phase 13G — see ImagePreviewPanel.tsx's identical props for the full
  // controlled/uncontrolled rationale.
  background?: ComparisonBackground
  onBackgroundChange?: (background: ComparisonBackground) => void
  showBackgroundToggle?: boolean
  compareMode?: CompareMode
  zoom?: number
}

// The Earring/Hoop override for the three props above — one shared source
// so EarringRunWorkspace (live) and BatchDetails (historical) can never
// drift into showing different labels/copy for the same images. Lives here,
// next to the defaults it overrides, rather than in either consumer.
export const EARRING_PREVIEW_OVERRIDES = {
  beforeLabel: 'Compare',
  afterLabel: 'Shadow',
  lowConfidenceMessage:
    'No confident front/rear split found — this split used a fallback estimate. Worth a closer look.',
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
  background: controlledBackground,
  onBackgroundChange: controlledOnBackgroundChange,
  showBackgroundToggle,
  compareMode,
  zoom,
}: RingBraceletImagePreviewPanelProps) {
  const [localBackground, setLocalBackground] = useState<ComparisonBackground>('neutral')
  const background = controlledBackground ?? localBackground
  const setBackground = controlledOnBackgroundChange ?? setLocalBackground
  // Stage backdrop toggle, keyboard 'B' (Phase 13F) — works identically
  // whether background is controlled (Batch Details, 13G) or not (Stage
  // workspaces, 13F).
  useBackdropCycle(background, setBackground)

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
              {image.needsFixing && <Flag size={11} strokeWidth={2} aria-hidden="true" />}
              {image.needsFixing ? 'Needs Fixing' : 'Mark as Needs Fixing'}
            </button>
          )}
          {onExpand && (
            <button className={styles.expandButton} onClick={onExpand} aria-label="View fullscreen" title="View fullscreen">
              <Maximize2 size={14} strokeWidth={1.5} aria-hidden="true" />
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
          showBackgroundToggle={showBackgroundToggle}
          compareMode={compareMode}
          zoom={zoom}
        />
        {image.detected === false && (
          <div className={styles.lowConfidence}>
            <AlertTriangle size={14} strokeWidth={1.5} className={styles.lowConfidenceIcon} aria-hidden="true" />
            <span>{lowConfidenceMessage}</span>
          </div>
        )}
        {image.needsFixing === true && (
          <div className={styles.needsFixing}>
            <Flag size={14} strokeWidth={1.5} className={styles.needsFixingIcon} aria-hidden="true" />
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
