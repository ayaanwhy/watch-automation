import { useState } from 'react'
import BatchSetup from './screens/BatchSetup'
import { AnnotationWorkspace } from './screens/AnnotationWorkspace'
import Preprocessing from './screens/Preprocessing'
import Settings from './screens/Settings'
import Home from './screens/Home'
import BatchDetails from './screens/BatchDetails'
import { AppShell } from './components/shell/AppShell'
import { PreprocessingJobProvider } from './context/PreprocessingJobContext'
import { PreprocessingBatchSync } from './components/batch/PreprocessingBatchSync'
import { findStageStatus } from './components/batch/batchDisplay'
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
  // PreprocessingBatchSync whenever that job starts/finishes, so its derived
  // status/currentStage are fresh enough to drive Preprocessing.tsx's
  // Configure/Run switch and the Continue-to-Watch decision.
  const [preprocessBatch, setPreprocessBatch] = useState<BatchDetailRecord | null>(null)

  // The batch backing the current annotation session (Phase 9E.1) — set
  // whenever one is created/resumed/reopened, read by the "Complete Batch"
  // action so it knows which batch's Watch stage to mark completed. Not used
  // for any create-vs-reuse decision (that's resolved explicitly in
  // handleBeginAnnotation/handleOpenBatch); purely "which batch is open."
  const [watchBatchId, setWatchBatchId] = useState<string | null>(null)

  // The batch explicitly opened from Home (Phase 9E) — reopens a terminal
  // batch into the permanent Batch Details screen. Historical batches are
  // always fetched fresh from the registry by BatchDetails itself; this is
  // just which id to fetch.
  const [openBatchId, setOpenBatchId] = useState<string | null>(null)

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
  // badge/opened-batch reference — never carrying anything a prior Home
  // launch or hand-off may have set — so behavior is identical regardless of
  // whether the workflow was entered from Home or the sidebar.
  function navigate(next: AppView) {
    if (next === 'preprocessing') setPendingBatch({ pipeline: ['preprocessing'], title: '' })
    if (next === 'watch') setPendingBatch({ pipeline: ['watch'], title: '' })
    setHandoffFolder(null)
    setOpenBatchId(null)
    setView(next)
  }

  // Home's "Create & Open": stashes the user's chosen pipeline/title and
  // navigates straight to the first stage's screen. No Batch exists yet.
  function handleLaunchFromHome(pipeline: StageType[], title: string) {
    setPendingBatch({ pipeline, title })
    setHandoffFolder(null)
    setOpenBatchId(null)
    setView(pipeline[0] === 'watch' ? 'watch' : 'preprocessing')
  }

  // Reopening a batch from Home (Phase 9E, hardened in 9E.1). Historical
  // batches always load from the registry, never from renderer memory: this
  // always fetches fresh, regardless of whether it happens to match whatever
  // App.tsx was already tracking. No blank screens and no path-selection
  // screen unless starting a genuinely new batch:
  //   Preprocessing running  → the live Run workspace
  //   Preprocessing terminal → Batch Details
  //   Watch running          → the annotation workspace directly (not BatchSetup)
  //   Watch terminal         → Batch Details
  async function handleOpenBatch(id: string) {
    const detail = await window.api.invoke('batch-registry:get', { id })
    if (!detail) return

    if (detail.status === 'in_progress' && detail.currentStage === 'preprocessing') {
      setPendingBatch(null)
      setPreprocessBatch(detail)
      setHandoffFolder(null)
      setOpenBatchId(null)
      setView('preprocessing')
      return
    }

    if (detail.status === 'in_progress' && detail.currentStage === 'watch') {
      await reopenLiveWatchBatch(detail)
      return
    }

    // Terminal (or draft/never-started) — the canonical Batch Details page.
    setOpenBatchId(id)
    setView('batchDetails')
  }

  // Reconstructs exactly what BatchSetup's own validate → match → session:load
  // sequence would produce, then jumps straight into AnnotationWorkspace —
  // reusing the same IPC contracts BatchSetup already relies on rather than
  // building a parallel path, so the annotation workflow itself is untouched.
  async function reopenLiveWatchBatch(detail: BatchDetailRecord): Promise<void> {
    const watchStage = detail.stages.find(s => s.type === 'watch')
    const inputFolder = watchStage?.inputDir ?? ''
    const outputFolder = watchStage?.outputDir ?? ''
    const spreadsheetPath =
      watchStage && typeof watchStage.config.spreadsheetPath === 'string' ? watchStage.config.spreadsheetPath : ''

    if (watchStage && inputFolder && outputFolder && spreadsheetPath) {
      const validation = await window.api.invoke('batch:validate', { inputFolder, spreadsheetPath, outputFolder })
      if (validation.ok) {
        const load = await window.api.invoke('batch:load', { inputFolder, spreadsheetPath })
        if (load.ok && load.match) {
          const sessionResult = await window.api.invoke('session:load', { inputFolder, outputFolder, spreadsheetPath })
          const batchState: BatchState = { inputFolder, outputFolder, spreadsheetPath, match: load.match }
          setPendingBatch(null)
          setHandoffFolder(null)
          setOpenBatchId(null)
          setWatchBatchId(detail.id)
          setEntry({ batch: batchState, initialSession: sessionResult.ok ? sessionResult.session : null })
          setScreen('annotation')
          setView('watch')
          return
        }
      }
    }

    // Paths no longer valid, or something's missing — degrade to BatchSetup
    // rather than a blank/broken workspace. Seed its own restore-on-mount so
    // the user immediately sees why (the same validation errors) instead of
    // landing on an unexplained blank form.
    if (inputFolder || outputFolder || spreadsheetPath) {
      await window.api.invoke('prefs:save-last-batch', { inputFolder, spreadsheetPath, outputFolder })
    }
    setPendingBatch(null)
    setHandoffFolder(null)
    setOpenBatchId(null)
    setWatchBatchId(null)
    setScreen('setup')
    setEntry(null)
    setView('watch')
  }

  // The single funnel for resolving which Batch a Preprocessing execution
  // belongs to — Watch has its own resolution in handleBeginAnnotation below,
  // since "Resume must never create a new batch" needs an extra lookup step
  // that Preprocessing (which has no resume concept) doesn't.
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

  // Clears whatever batch App.tsx was tracking and returns to a fresh
  // Preprocessing Configure screen — the same "Run another batch" semantic
  // Phase 9D introduced, now reachable identically from either the live
  // Preprocessing screen's own terminal state or a historical batch opened
  // from Home (both render the same BatchDetails screen; see renderContent).
  function handleRunAnotherPreprocessing() {
    setPreprocessBatch(null)
    setPendingBatch({ pipeline: ['preprocessing'], title: '' })
    setHandoffFolder(null)
    setOpenBatchId(null)
    setView('preprocessing')
  }

  // Redesigned around the Batch model (Phase 9C): this is a stage transition
  // on the SAME batch, never a session restore and never a new batch. It
  // hands the batch's id to the next screen via pendingBatch.continueBatchId
  // so Begin Annotation reuses it instead of minting one. Takes the target
  // batch explicitly (Phase 9E) so it works identically whether triggered
  // from the live Preprocessing screen (preprocessBatch) or a historical
  // batch's Batch Details page (openBatchId) — not just the currently-tracked
  // one.
  async function handleContinueToWatchProcessing(
    batch: BatchDetailRecord,
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
    setOpenBatchId(null)
    setView('watch')
    return { ok: true }
  }

  // Batch identity, hardened (Phase 9E.1): resolves which batch this
  // execution belongs to via a strict, explicit precedence —
  //   1. an explicit continuation (pendingBatch.continueBatchId — a hand-off
  //      or a reopened in-progress batch) always wins and is never re-looked-up;
  //   2. Resume (initialSession !== null — BatchSetup only ever passes a
  //      session on its "Resume" button) must never create a new batch: find
  //      the batch this session already belongs to by the exact same
  //      inputFolder/outputFolder/spreadsheetPath already stored on its stage,
  //      falling back to creating one only if truly none exists (e.g. an
  //      orphaned session from before this fix);
  //   3. anything else (Begin Annotation with no prior session, or explicit
  //      "Start fresh") intentionally creates a brand new batch — this is the
  //      one and only path that mints new Watch batches for a first-time or
  //      deliberately-restarted run.
  async function resolveWatchBatchId(
    batch: BatchState,
    initialSession: SessionFile | null,
    title: string,
  ): Promise<string> {
    if (pendingBatch?.continueBatchId) {
      const id = pendingBatch.continueBatchId
      setPendingBatch(null)
      return id
    }
    if (initialSession !== null) {
      const existing = await window.api.invoke('batch-registry:find-watch', {
        inputFolder: batch.inputFolder,
        outputFolder: batch.outputFolder,
        spreadsheetPath: batch.spreadsheetPath,
      })
      setPendingBatch(null)
      if (existing) return existing.id
    }
    return createBatch(['watch'], batch.inputFolder, title)
  }

  async function handleBeginAnnotation(
    batch: BatchState,
    initialSession: SessionFile | null,
    batchName: string,
  ) {
    const id = await resolveWatchBatchId(batch, initialSession, batchName)
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
    setWatchBatchId(id)
    setHandoffFolder(null)
    setEntry({ batch, initialSession })
    setScreen('annotation')
  }

  // Explicit "Complete Batch" (Phase 9E.1): once annotation/queue work is
  // finished, marks the Watch stage completed and returns to Home. A
  // completed batch always reopens into Batch Details from then on (handled
  // automatically by handleOpenBatch's terminal fallthrough).
  async function handleCompleteWatchBatch() {
    if (!watchBatchId) return
    if (!window.confirm('Mark this batch complete and return to Home?')) return
    await window.api.invoke('batch-registry:update-stage', {
      id: watchBatchId,
      stageType: 'watch',
      patch: { status: 'completed' },
    })
    setWatchBatchId(null)
    setEntry(null)
    setScreen('setup')
    setView('home')
  }

  function handleBack() {
    setScreen('setup')
    setEntry(null)
    setWatchBatchId(null)
  }

  function renderContent() {
    if (view === 'home') return <Home onLaunch={handleLaunchFromHome} onOpenBatch={handleOpenBatch} />
    if (view === 'settings') return <Settings />

    if (view === 'batchDetails' && openBatchId) {
      return (
        <BatchDetails
          batchId={openBatchId}
          onBack={() => setView('home')}
          onRunAnotherPreprocessing={handleRunAnotherPreprocessing}
          onContinueToWatchProcessing={handleContinueToWatchProcessing}
        />
      )
    }

    if (view === 'preprocessing') {
      const stageStatus = findStageStatus(preprocessBatch, 'preprocessing')
      // A terminal preprocessing batch's outcome is shown via the exact same
      // canonical Batch Details screen a historical batch reopens into —
      // there is only ever one implementation of "what does a finished
      // Preprocessing stage look like" (Phase 9E).
      if (stageStatus === 'completed' || stageStatus === 'failed' || stageStatus === 'cancelled') {
        return (
          <BatchDetails
            batchId={preprocessBatch!.id}
            onBack={() => setView('home')}
            onRunAnotherPreprocessing={handleRunAnotherPreprocessing}
            onContinueToWatchProcessing={handleContinueToWatchProcessing}
          />
        )
      }
      return (
        <Preprocessing
          batch={preprocessBatch}
          initialBatchName={pendingBatch?.title ?? ''}
          onCreateBatch={handleCreatePreprocessingBatch}
        />
      )
    }

    // view === 'watch'
    return screen === 'annotation' && entry !== null ? (
      <AnnotationWorkspace
        batch={entry.batch}
        initialSession={entry.initialSession}
        onBack={handleBack}
        onCompleteBatch={handleCompleteWatchBatch}
      />
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
    // on both start and finish, even if the user has navigated away from the
    // screen — it is unconditional, not gated on the current view, so
    // revisitability holds for the Configure/Run switch and the
    // Continue-to-Watch decision alike. Stage status itself is never written
    // from here — the main process owns that (Phase 9C).
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
