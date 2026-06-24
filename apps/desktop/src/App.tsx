import { useState } from 'react'
import BatchSetup from './screens/BatchSetup'
import { AnnotationWorkspace } from './screens/AnnotationWorkspace'
import type { BatchState } from './types/annotation'

export default function App() {
  const [screen, setScreen] = useState<'setup' | 'annotation'>('setup')
  const [batch, setBatch] = useState<BatchState | null>(null)

  function handleBeginAnnotation(b: BatchState) {
    setBatch(b)
    setScreen('annotation')
  }

  function handleBack() {
    setScreen('setup')
    setBatch(null)
  }

  if (screen === 'annotation' && batch !== null) {
    return <AnnotationWorkspace batch={batch} onBack={handleBack} />
  }

  return <BatchSetup onBeginAnnotation={handleBeginAnnotation} />
}
