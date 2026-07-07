import { useState } from 'react'
import { usePreprocessingJob } from '../../context/PreprocessingJobContext'
import { PreprocessingProgress } from '../PreprocessingProgress'
import { ThumbnailGrid } from './ThumbnailGrid'
import { ImagePreviewPanel } from './ImagePreviewPanel'
import styles from './PreprocessingRunWorkspace.module.css'

interface PreprocessingRunWorkspaceProps {
  inputDir: string
}

// The live execution workspace — dark, matching Watch Processing's Annotation
// design language. The thumbnail grid is the primary navigation surface;
// PreprocessingProgress (unchanged) is reused rather than reimplemented,
// absorbed here as the elapsed/overall-progress/cancel panel.
export function PreprocessingRunWorkspace({ inputDir }: PreprocessingRunWorkspaceProps) {
  const job = usePreprocessingJob()

  // The currently-processing image stays selected automatically unless the
  // user explicitly picks another thumbnail — once they do, their choice
  // sticks for the rest of the run.
  const [manualSelection, setManualSelection] = useState<string | null>(null)
  const selectedName = manualSelection ?? job.progress.currentImage
  const selectedImage = job.images.find(img => img.name === selectedName) ?? null

  return (
    <div className={styles.workspace}>
      <div className={styles.gridStage}>
        <div className={styles.gridArea}>
          <ThumbnailGrid
            images={job.images}
            inputDir={inputDir}
            selectedImage={selectedName}
            onSelect={setManualSelection}
          />
        </div>
      </div>
      <div className={styles.sidebar}>
        <div className={styles.previewArea}>
          <ImagePreviewPanel image={selectedImage} inputDir={inputDir} mode="run" />
        </div>
        <PreprocessingProgress
          progress={job.progress}
          cancelPhase={job.cancelPhase}
          startedAt={job.startedAt}
          onCancel={job.cancel}
        />
      </div>
    </div>
  )
}
