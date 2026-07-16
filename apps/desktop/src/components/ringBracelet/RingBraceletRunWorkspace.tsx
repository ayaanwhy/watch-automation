import { useState } from 'react'
import { useRingBraceletJob } from '../../context/RingBraceletJobContext'
import { PreprocessingProgress } from '../PreprocessingProgress'
import { ThumbnailGrid } from '../preprocessing/ThumbnailGrid'
import { RingBraceletImagePreviewPanel } from './RingBraceletImagePreviewPanel'
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

  return (
    <div className={styles.workspace}>
      <div className={styles.previewArea}>
        <RingBraceletImagePreviewPanel image={selectedImage} inputDir={inputDir} />
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
            images={job.images}
            inputDir={inputDir}
            selectedImage={selectedName}
            onSelect={setManualSelection}
          />
        </div>
      </div>
    </div>
  )
}
