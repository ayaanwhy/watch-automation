import { useState } from 'react'
import { useRingBraceletJob } from '../../context/RingBraceletJobContext'
import { PreprocessingProgress } from '../PreprocessingProgress'
import { ThumbnailGrid, findAdjacentImage } from '../preprocessing/ThumbnailGrid'
import { RingBraceletImagePreviewPanel } from './RingBraceletImagePreviewPanel'
import { FullscreenViewer } from '../ui/FullscreenViewer'
// Reuses Preprocessing's run-workspace layout directly — same shape (primary
// preview + progress/thumbnail sidebar), no parallel CSS file.
import styles from '../preprocessing/PreprocessingRunWorkspace.module.css'

interface RingBraceletRunWorkspaceProps {
  inputDir: string
}

// Mirrors PreprocessingRunWorkspace exactly, bound to RingBraceletJobContext
// instead. PreprocessingProgress is reused unchanged — its heartbeat/
// initializing-stage fields are simply never populated by this job (the
// runner has no such concept), which the component already renders as
// gracefully absent rather than broken.
export function RingBraceletRunWorkspace({ inputDir }: RingBraceletRunWorkspaceProps) {
  const job = useRingBraceletJob()

  const [manualSelection, setManualSelection] = useState<string | null>(null)
  const selectedName = manualSelection ?? job.progress.currentImage
  const selectedImage = job.images.find(img => img.name === selectedName) ?? null
  // ThumbnailGrid's lowConfidence badge (Phase 10F) surfaces this job's own
  // existing detected flag — not a new signal, just visible earlier than
  // clicking through to the full preview panel.
  const gridImages = job.images.map(img => ({ ...img, lowConfidence: img.detected === false }))

  // Fullscreen review (Phase 10F) — reuses the same selection state above;
  // no separate index tracking needed.
  const [fullscreen, setFullscreen] = useState(false)
  const prevName = findAdjacentImage(job.images, selectedName, -1)
  const nextName = findAdjacentImage(job.images, selectedName, 1)

  return (
    <div className={styles.workspace}>
      <div className={styles.previewArea}>
        <RingBraceletImagePreviewPanel image={selectedImage} inputDir={inputDir} onExpand={() => setFullscreen(true)} />
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
          <RingBraceletImagePreviewPanel image={selectedImage} inputDir={inputDir} />
        </FullscreenViewer>
      )}
    </div>
  )
}
