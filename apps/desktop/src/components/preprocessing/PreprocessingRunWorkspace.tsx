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
// design language. The image preview is the primary focus while processing
// (Phase 9E.2): a finished image's before/after comparison is available
// immediately, live, not only once the whole batch completes. The thumbnail
// grid is a narrower, virtualized navigation strip alongside it rather than
// the dominant element — PreprocessingProgress (unchanged) sits above it,
// reused rather than reimplemented.
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
      <div className={styles.previewArea}>
        <ImagePreviewPanel image={selectedImage} inputDir={inputDir} />
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
