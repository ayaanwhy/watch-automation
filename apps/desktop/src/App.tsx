import { useState } from 'react'
import BatchSetup from './screens/BatchSetup'
import { AnnotationWorkspace } from './screens/AnnotationWorkspace'
import Preprocessing from './screens/Preprocessing'
import type { BatchState } from './types/annotation'
import type { SessionFile } from './types/session'

interface AnnotationEntry {
  batch: BatchState
  initialSession: SessionFile | null
}

// TEMPORARY (Phase 8.5C) — there is no real module navigation yet (that is
// Phase 8.5B). This toggle exists only so the new Preprocessing screen is
// reachable during development without disturbing the existing Watch
// Processing flow below. Remove this toggle and DevModuleToggle once real
// navigation mounts Preprocessing.
type DevModule = 'watch' | 'preprocessing'

export default function App() {
  const [devModule, setDevModule] = useState<DevModule>('watch')
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
    <>
      <DevModuleToggle devModule={devModule} onChange={setDevModule} />
      {devModule === 'preprocessing' ? (
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
    </>
  )
}

// TEMPORARY (Phase 8.5C) — deliberately unstyled / outside the design
// system so it reads as scaffolding, not a real UI element. See note above.
function DevModuleToggle({
  devModule,
  onChange,
}: {
  devModule: DevModule
  onChange: (m: DevModule) => void
}) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 8,
        right: 8,
        zIndex: 9999,
        display: 'flex',
        gap: 6,
        fontFamily: 'sans-serif',
        fontSize: 11,
      }}
    >
      <button
        style={{ padding: '4px 8px', cursor: 'pointer', fontWeight: devModule === 'watch' ? 700 : 400 }}
        onClick={() => onChange('watch')}
      >
        Watch Processing
      </button>
      <button
        style={{ padding: '4px 8px', cursor: 'pointer', fontWeight: devModule === 'preprocessing' ? 700 : 400 }}
        onClick={() => onChange('preprocessing')}
      >
        Preprocessing (dev)
      </button>
    </div>
  )
}
