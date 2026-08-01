import { useState } from 'react'
import { useEarringJob } from '../../context/EarringJobContext'
import { PreprocessingProgress } from '../PreprocessingProgress'
import { ThumbnailGrid, findAdjacentImage } from '../shared/ThumbnailGrid'
import { RingBraceletImagePreviewPanel, EARRING_PREVIEW_OVERRIDES } from '../ringBracelet/RingBraceletImagePreviewPanel'
import { FullscreenViewer } from '../ui/FullscreenViewer'
// Shares RunWorkspace's layout stylesheet with Preprocessing/RingBracelet's
// own workspaces (Phase 11C/10D) — same shape, no parallel CSS file.
import styles from '../shared/RunWorkspace.module.css'

interface EarringRunWorkspaceProps {
  inputDir: string
}

// Mirrors RingBraceletRunWorkspace exactly, bound to EarringJobContext.
// Reuses RingBraceletImagePreviewPanel directly rather than a new component
// — see EarringImageState's doc comment for why that's structurally safe —
// EARRING_PREVIEW_OVERRIDES swaps in Earring's own slider labels/copy (the
// same object BatchDetails.tsx uses for the historical view, so a Hoop image
// reads identically live or reopened later). Stud/Drop have no masking step
// and therefore no detected signal (always null), so lowConfidence naturally
// never badges those; Hoop (Phase 12D) does report detected, driven through
// the same field.
export function EarringRunWorkspace({ inputDir }: EarringRunWorkspaceProps) {
  const job = useEarringJob()

  const [manualSelection, setManualSelection] = useState<string | null>(null)
  const selectedName = manualSelection ?? job.progress.currentImage
  const selectedImage = job.images.find(img => img.name === selectedName) ?? null
  const gridImages = job.images.map(img => ({ ...img, lowConfidence: img.detected === false, needsFixing: img.needsFixing === true }))

  const [fullscreen, setFullscreen] = useState(false)
  const prevName = findAdjacentImage(job.images, selectedName, -1)
  const nextName = findAdjacentImage(job.images, selectedName, 1)

  return (
    <div className={styles.workspace}>
      <div className={styles.previewArea}>
        <RingBraceletImagePreviewPanel
          image={selectedImage}
          inputDir={inputDir}
          onExpand={() => setFullscreen(true)}
          {...EARRING_PREVIEW_OVERRIDES}
        />
      </div>
      <div className={styles.sidebar}>
        <PreprocessingProgress
          progress={job.progress}
          cancelPhase={job.cancelPhase}
          startedAt={job.startedAt}
          onCancel={job.cancel}
        />
        <div className={styles.gridArea}>
          <ThumbnailGrid
            images={gridImages}
            inputDir={inputDir}
            selectedImage={selectedName}
            onSelect={setManualSelection}
          />
        </div>
      </div>

      {fullscreen && (
        <FullscreenViewer
          title={selectedImage?.name}
          onClose={() => setFullscreen(false)}
          onPrev={() => prevName && setManualSelection(prevName)}
          onNext={() => nextName && setManualSelection(nextName)}
          hasPrev={prevName !== null}
          hasNext={nextName !== null}
        >
          <RingBraceletImagePreviewPanel
            image={selectedImage}
            inputDir={inputDir}
            {...EARRING_PREVIEW_OVERRIDES}
          />
        </FullscreenViewer>
      )}
    </div>
  )
}
