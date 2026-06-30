import { useState } from 'react'
import BatchSetup from './screens/BatchSetup'
import { AnnotationWorkspace } from './screens/AnnotationWorkspace'
import Preprocessing from './screens/Preprocessing'
import ModuleSelector from './screens/ModuleSelector'
import { PreprocessingJobProvider } from './context/PreprocessingJobContext'
import type { BatchState } from './types/annotation'
import type { SessionFile } from './types/session'
import type { AppModule } from './types/navigation'
import styles from './App.module.css'

interface AnnotationEntry {
  batch: BatchState
  initialSession: SessionFile | null
}

export default function App() {
  const [activeModule, setActiveModule] = useState<AppModule>('selector')

  // Watch Processing's own setup/annotation state. Lives here, untouched by
  // which module is currently displayed, so leaving and returning to Watch
  // Processing resumes exactly where it was (same as before this change).
  const [screen, setScreen] = useState<'setup' | 'annotation'>('setup')
  const [entry, setEntry] = useState<AnnotationEntry | null>(null)

  function handleBeginAnnotation(batch: BatchState, initialSession: SessionFile | null) {
    setEntry({ batch, initialSession })
    setScreen('annotation')
  }

  function handleBack() {
    setScreen('setup')
    setEntry(null)
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
              ← Watch Automation
            </button>
          </div>
        )}

        <div className={styles.shellBody}>
          {activeModule === 'selector' ? (
            <ModuleSelector onSelect={setActiveModule} />
          ) : activeModule === 'preprocessing' ? (
            <Preprocessing />
          ) : screen === 'annotation' && entry !== null ? (
            <AnnotationWorkspace
              batch={entry.batch}
              initialSession={entry.initialSession}
              onBack={handleBack}
            />
          ) : (
            <BatchSetup onBeginAnnotation={handleBeginAnnotation} />
          )}
        </div>
      </div>
    </PreprocessingJobProvider>
  )
}
