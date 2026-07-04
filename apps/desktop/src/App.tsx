import { useState, useEffect } from 'react'
import BatchSetup from './screens/BatchSetup'
import { AnnotationWorkspace } from './screens/AnnotationWorkspace'
import Preprocessing from './screens/Preprocessing'
import ModuleSelector from './screens/ModuleSelector'
import { PreprocessingJobProvider } from './context/PreprocessingJobContext'
import type { BatchState } from './types/annotation'
import type { SessionFile } from './types/session'
import type { AppModule, LaunchableModule } from './types/navigation'
import styles from './App.module.css'

interface AnnotationEntry {
  batch: BatchState
  initialSession: SessionFile | null
}

const MODULE_LABELS: Record<LaunchableModule, string> = {
  preprocessing: 'Preprocessing',
  watch: 'Watch Processing',
}

export default function App() {
  const [activeModule, setActiveModule] = useState<AppModule>('selector')

  // Watch Processing's own setup/annotation state. Lives here, untouched by
  // which module is currently displayed, so leaving and returning to Watch
  // Processing resumes exactly where it was.
  const [screen, setScreen] = useState<'setup' | 'annotation'>('setup')
  const [entry, setEntry] = useState<AnnotationEntry | null>(null)

  // Set when navigating to Watch Processing via Continue after preprocessing.
  // Cleared automatically whenever the user leaves the Watch Processing module
  // so that navigating back to it directly shows the normal BatchSetup.
  const [handoffFolder, setHandoffFolder] = useState<string | null>(null)

  useEffect(() => {
    if (activeModule !== 'watch') setHandoffFolder(null)
  }, [activeModule])

  function handleBeginAnnotation(batch: BatchState, initialSession: SessionFile | null) {
    setEntry({ batch, initialSession })
    setScreen('annotation')
  }

  function handleBack() {
    setScreen('setup')
    setEntry(null)
  }

  // Prepares the preprocessing output for Watch Processing (trim + rotate
  // into a "<outputDir> - WatchReady" sibling folder — see
  // electron/services/workflowPreparation.ts) and only proceeds with the
  // navigation hand-off if that succeeds. Returns the outcome so
  // PreprocessingSummary can show progress and surface any error without
  // leaving Preprocessing.
  async function handleContinueToWatchProcessing(
    outputDir: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (!outputDir) {
      return { ok: false, error: 'No preprocessing output folder to prepare.' }
    }

    const result = await window.api.invoke('preprocess:prepare-for-watch-processing', {
      sourceDir: outputDir,
    })
    if (!result.ok) {
      return { ok: false, error: result.error }
    }

    // Start Watch Processing with a clean slate — only the prepared input
    // folder is carried over. Spreadsheet and output folder are intentionally
    // cleared so the user begins a fresh session.
    await window.api.invoke('prefs:save-last-batch', {
      inputFolder: result.preparedDir,
      spreadsheetPath: null,
      outputFolder: null,
    })
    setHandoffFolder(result.preparedDir)
    setActiveModule('watch')
    return { ok: true }
  }

  return (
    // PreprocessingJobProvider wraps the whole shell so an in-progress
    // preprocessing job (and its IPC subscription) survives navigating to
    // another module and back — see PreprocessingJobContext.
    <PreprocessingJobProvider>
      <div className={styles.shell}>
        {activeModule !== 'selector' && (
          <div className={styles.shellHeader}>
            <button className={styles.homeLink} onClick={() => setActiveModule('selector')}>
              ← Modules
            </button>
            <span className={styles.moduleLabel}>
              {MODULE_LABELS[activeModule as LaunchableModule]}
            </span>
          </div>
        )}

        <div className={styles.shellBody}>
          {activeModule === 'selector' ? (
            <ModuleSelector onSelect={setActiveModule} />
          ) : activeModule === 'preprocessing' ? (
            <Preprocessing onContinueToWatchProcessing={handleContinueToWatchProcessing} />
          ) : screen === 'annotation' && entry !== null ? (
            <AnnotationWorkspace
              batch={entry.batch}
              initialSession={entry.initialSession}
              onBack={handleBack}
            />
          ) : (
            <BatchSetup
              onBeginAnnotation={handleBeginAnnotation}
              handoffFolder={handoffFolder}
            />
          )}
        </div>
      </div>
    </PreprocessingJobProvider>
  )
}
