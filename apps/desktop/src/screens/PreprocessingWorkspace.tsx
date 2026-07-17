import { PreprocessingRunWorkspace } from '../components/preprocessing/PreprocessingRunWorkspace'
import styles from './PreprocessingWorkspace.module.css'

interface PreprocessingWorkspaceProps {
  inputDir: string
  onBack: () => void
}

// Dedicated live-run screen (Phase 10F correction) — separate from
// Preprocessing.tsx's listing/launcher. Reuses PreprocessingRunWorkspace
// (progress + thumbnails + preview) unchanged, just adds the page-level
// chrome (title + Back) a standalone screen needs. Back always returns to
// the Preprocessing listing, never Home — see App.tsx's navigate().
export default function PreprocessingWorkspace({ inputDir, onBack }: PreprocessingWorkspaceProps) {
  return (
    <div className={styles.screen}>
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onBack}>
          ← Preprocessing
        </button>
      </div>
      <div className={styles.body}>
        <PreprocessingRunWorkspace inputDir={inputDir} />
      </div>
    </div>
  )
}
