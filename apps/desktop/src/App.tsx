import { useState } from 'react'
import BatchSetup from './screens/BatchSetup'
import { AnnotationWorkspace } from './screens/AnnotationWorkspace'
import type { BatchState } from './types/annotation'
import type { SessionFile } from './types/session'

interface AnnotationEntry {
  batch: BatchState
  initialSession: SessionFile | null
}

export default function App() {
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

  if (screen === 'annotation' && entry !== null) {
    return (
      <AnnotationWorkspace
        batch={entry.batch}
        initialSession={entry.initialSession}
        onBack={handleBack}
      />
    )
  }

  return <BatchSetup onBeginAnnotation={handleBeginAnnotation} />
}
