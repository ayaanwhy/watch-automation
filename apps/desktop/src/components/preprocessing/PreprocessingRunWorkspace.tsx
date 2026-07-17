import { useState } from 'react'
import { usePreprocessingJob } from '../../context/PreprocessingJobContext'
import { PreprocessingProgress } from '../PreprocessingProgress'
import { ThumbnailGrid, findAdjacentImage } from './ThumbnailGrid'
import { ImagePreviewPanel } from './ImagePreviewPanel'
import { FullscreenViewer } from '../ui/FullscreenViewer'
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

  // Fullscreen review (Phase 10F) — reuses the same selection state above;
  // no separate index tracking needed.
  const [fullscreen, setFullscreen] = useState(false)
  const prevName = findAdjacentImage(job.images, selectedName, -1)
  const nextName = findAdjacentImage(job.images, selectedName, 1)

  return (
    <div className={styles.workspace}>
      <div className={styles.previewArea}>
        <ImagePreviewPanel image={selectedImage} inputDir={inputDir} onExpand={() => setFullscreen(true)} />
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

      {fullscreen && (
        <FullscreenViewer
          title={selectedImage?.name}
          onClose={() => setFullscreen(false)}
          onPrev={() => prevName && setManualSelection(prevName)}
          onNext={() => nextName && setManualSelection(nextName)}
          hasPrev={prevName !== null}
          hasNext={nextName !== null}
        >
          <ImagePreviewPanel image={selectedImage} inputDir={inputDir} />
        </FullscreenViewer>
      )}
    </div>
  )
}
