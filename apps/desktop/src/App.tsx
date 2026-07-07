import { useState } from 'react'
import BatchSetup from './screens/BatchSetup'
import { AnnotationWorkspace } from './screens/AnnotationWorkspace'
import Preprocessing from './screens/Preprocessing'
import Settings from './screens/Settings'
import Home from './screens/Home'
import { AppShell } from './components/shell/AppShell'
import { PreprocessingJobProvider } from './context/PreprocessingJobContext'
import { PreprocessingBatchSync } from './components/batch/PreprocessingBatchSync'
import type { BatchState } from './types/annotation'
import type { SessionFile } from './types/session'
import type { AppView } from './types/navigation'
import type { BatchDetailRecord, StageType } from './types/batch'

interface AnnotationEntry {
  batch: BatchState
  initialSession: SessionFile | null
}

// A workflow launch not yet backed by a real Batch record. Set either by
// Home's "Create & Open" (carrying the user's chosen pipeline/title) or by a
// sidebar shortcut (a bare single-stage default). Consumed — and a real Batch
// created or reused — only when the workflow's execution action fires
// (Preprocessing Start / Begin Annotation), so every entry path funnels
// through the exact same resolution call.
interface PendingBatch {
  pipeline: StageType[]
  title: string
  // Set only by the Preprocessing → Watch hand-off (see
  // handleContinueToWatchProcessing): continues an EXISTING batch's next
  // stage instead of minting a new one. A hand-off is a stage transition on
  // the same historical execution, not a new batch.
  continueBatchId?: string
}

export default function App() {
  const [view, setView] = useState<AppView>('home')
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null)

  // The batch backing the current/most-recent preprocessing run. Refreshed by
  // PreprocessingBatchSync whenever that job finishes, so its derived
  // currentStage/nextStage are fresh enough to decide whether to offer
  // "Continue to Watch Processing".
  const [preprocessBatch, setPreprocessBatch] = useState<BatchDetailRecord | null>(null)

  // Set only during a Preprocessing → Watch hand-off, so BatchSetup can show
  // its "Prepared ✓" badge/helper message. This is a Watch-screen UX nicety —
  // orthogonal to (and coexists with) BatchSetup's own prefs-based "restore
  // last used folders" convenience: the hand-off writes those same prefs
  // (see handleContinueToWatchProcessing), and BatchSetup's existing
  // restore-on-mount effect naturally picks them up. Which *Batch* record an
  // execution belongs to (pendingBatch) is a separate, explicit concern from
  // which *folder values* prefill the form (prefs) — they never conflict.
  const [handoffFolder, setHandoffFolder] = useState<string | null>(null)

  // Watch stage sub-state — unchanged by prior refinements so leaving and
  // returning to Watch Processing resumes exactly where it was.
  const [screen, setScreen] = useState<'setup' | 'annotation'>('setup')
  const [entry, setEntry] = useState<AnnotationEntry | null>(null)

  // Sidebar shortcuts are pure navigation into a workflow: they always seed a
  // bare, untitled, single-stage pending spec and clear any stale hand-off
  // badge — never carrying anything a prior Home launch or hand-off may have
  // set — so behavior is identical regardless of whether the workflow was
  // entered from Home or the sidebar.
  function navigate(next: AppView) {
    if (next === 'preprocessing') setPendingBatch({ pipeline: ['preprocessing'], title: '' })
    if (next === 'watch') setPendingBatch({ pipeline: ['watch'], title: '' })
    setHandoffFolder(null)
    setView(next)
  }

  // Home's "Create & Open": stashes the user's chosen pipeline/title and
  // navigates straight to the first stage's screen. No Batch exists yet.
  function handleLaunchFromHome(pipeline: StageType[], title: string) {
    setPendingBatch({ pipeline, title })
    setHandoffFolder(null)
    setView(pipeline[0] === 'watch' ? 'watch' : 'preprocessing')
  }

  // The single funnel for resolving which Batch an execution belongs to —
  // used by both the Preprocessing Start handler and the Watch Begin
  // Annotation handler, so every entry path (Home, sidebar, or a stage
  // hand-off) produces identical downstream behavior.
  async function createBatch(defaultPipeline: StageType[], sourceDir: string, title: string): Promise<string> {
    if (pendingBatch?.continueBatchId) {
      const id = pendingBatch.continueBatchId
      setPendingBatch(null)
      return id
    }
    const pipeline = pendingBatch?.pipeline ?? defaultPipeline
    const detail = await window.api.invoke('batch-registry:create', {
      sourceDir,
      pipeline,
      title: title.trim() || undefined,
    })
    // Consumed once; a second run on the same screen (e.g. "Run another
    // batch" without re-navigating) falls back to defaultPipeline/no title —
    // each execution still gets its own new Batch (instance identity).
    setPendingBatch(null)
    return detail.id
  }

  async function handleCreatePreprocessingBatch(sourceDir: string, title: string): Promise<string> {
    const id = await createBatch(['preprocessing'], sourceDir, title)
    const detail = await window.api.invoke('batch-registry:get', { id })
    setPreprocessBatch(detail)
    return id
  }

  // Redesigned around the Batch model (Phase 9C): this is a stage transition
  // on the SAME batch, never a session restore and never a new batch. It
  // hands the batch's id to the next screen via pendingBatch.continueBatchId
  // so Begin Annotation reuses it instead of minting one.
  async function handleContinueToWatchProcessing(
    outputDir: string
  ): Promise<{ ok: boolean; error?: string }> {
    const batch = preprocessBatch
    if (!batch) {
      return { ok: false, error: 'No active batch to continue.' }
    }
    if (!outputDir) {
      return { ok: false, error: 'No preprocessing output folder to prepare.' }
    }

    const result = await window.api.invoke('preprocess:prepare-for-watch-processing', {
      sourceDir: outputDir,
    })
    if (!result.ok) {
      return { ok: false, error: result.error }
    }

    // Watch-screen convenience prefill only — orthogonal to batch identity,
    // see the handoffFolder comment above.
    await window.api.invoke('prefs:save-last-batch', {
      inputFolder: result.preparedDir,
      spreadsheetPath: null,
      outputFolder: null,
    })
    setHandoffFolder(result.preparedDir)
    setPendingBatch({ pipeline: batch.pipeline, title: batch.title, continueBatchId: batch.id })
    setPreprocessBatch(null)
    setView('watch')
    return { ok: true }
  }

  async function handleBeginAnnotation(
    batch: BatchState,
    initialSession: SessionFile | null,
    batchName: string,
  ) {
    const id = await createBatch(['watch'], batch.inputFolder, batchName)
    void window.api.invoke('batch-registry:update-stage', {
      id,
      stageType: 'watch',
      patch: {
        status: 'running',
        inputDir: batch.inputFolder,
        outputDir: batch.outputFolder,
        config: { spreadsheetPath: batch.spreadsheetPath },
      },
    })
    setHandoffFolder(null)
    setEntry({ batch, initialSession })
    setScreen('annotation')
  }

  function handleBack() {
    setScreen('setup')
    setEntry(null)
  }

  function renderContent() {
    if (view === 'home') return <Home onLaunch={handleLaunchFromHome} />
    if (view === 'settings') return <Settings />
    if (view === 'preprocessing') {
      return (
        <Preprocessing
          batch={preprocessBatch}
          initialBatchName={pendingBatch?.title ?? ''}
          onCreateBatch={handleCreatePreprocessingBatch}
          onContinueToWatchProcessing={
            preprocessBatch?.currentStage === 'watch' ? handleContinueToWatchProcessing : undefined
          }
          onRunAnother={() => setPreprocessBatch(null)}
        />
      )
    }
    // view === 'watch'
    return screen === 'annotation' && entry !== null ? (
      <AnnotationWorkspace batch={entry.batch} initialSession={entry.initialSession} onBack={handleBack} />
    ) : (
      <BatchSetup
        initialBatchName={pendingBatch?.title ?? ''}
        onBeginAnnotation={handleBeginAnnotation}
        handoffFolder={handoffFolder}
      />
    )
  }

  return (
    // PreprocessingJobProvider wraps the whole shell so an in-progress
    // preprocessing job (and its IPC subscription) survives navigation.
    // PreprocessingBatchSync observes that job and refreshes preprocessBatch
    // once it finishes, even if the user has navigated away from the screen —
    // it is unconditional, not gated on the current view, so revisitability
    // holds for the Continue-to-Watch decision too. Stage status itself is no
    // longer written from here — the main process owns that (Phase 9C).
    <PreprocessingJobProvider>
      <PreprocessingBatchSync
        batchId={preprocessBatch?.id ?? null}
        onBatchUpdated={setPreprocessBatch}
      />
      <AppShell view={view} onNavigate={navigate}>
        {renderContent()}
      </AppShell>
    </PreprocessingJobProvider>
  )
}
