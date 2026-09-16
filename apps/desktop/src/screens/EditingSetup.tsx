import { useEffect, useState, type ReactNode } from 'react'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { PathField } from '../components/PathField'
import { ConsoleLayout } from '../components/console/ConsoleLayout'
import { ConsoleSummaryPanel, type ConsoleSummaryItem } from '../components/console/ConsoleSummaryPanel'
import { ResumePrompt } from '../components/console/ResumePrompt'
import { PrepareInputDisclosure } from '../components/editing/PrepareInputDisclosure'
import { useToast } from '../components/ui/ToastHost'
import BatchSetup from './BatchSetup'
import { useRingBraceletFolders } from '../hooks/useRingBraceletFolders'
import { useEarringFolders } from '../hooks/useEarringFolders'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useRingBraceletJob } from '../context/RingBraceletJobContext'
import { useEarringJob } from '../context/EarringJobContext'
import { PROCESSING_MODE_OPTIONS } from '../constants/processingMode'
import type { ProcessingMode } from '../constants/processingMode'
import type { BatchState } from '../types/annotation'
import type { SessionFile } from '../types/session'
import type { EditingProduct } from '../types/navigation'
import type { BatchValidationResult, ProductMetadataLoadResult } from '../types/ipc'
import type { BatchDetailRecord, BatchMode } from '../types/batch'
import type { EarringType } from '../constants/earringClassification'
import styles from './EditingSetup.module.css'

const PRODUCT_OPTIONS: { value: EditingProduct; label: string }[] = [
  { value: 'watch', label: 'Watch' },
  { value: 'ring', label: 'Ring' },
  { value: 'bracelet', label: 'Bracelet' },
  { value: 'earring', label: 'Earring' },
]

const MODE_OPTIONS: { value: BatchMode; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'testing', label: 'Testing' },
]

interface EditingSetupProps {
  product: EditingProduct
  onProductChange: (product: EditingProduct) => void
  // Seeds the optional batch-name field — set when this screen was entered
  // via Home's "Create & Open" with a custom title; empty for a sidebar entry.
  initialBatchName: string
  // Watch — passed straight through to the unchanged BatchSetup.
  onBeginAnnotation: (batch: BatchState, initialSession: SessionFile | null, batchName: string) => void
  handoffFolder: string | null
  // Ring & Bracelet — resolves/creates the Batch backing this run, mirroring
  // Preprocessing's onCreateBatch. Called before job.start() so its id can be
  // forwarded to the runner. resumeBatchId (Item 3, post-Phase-13 polish):
  // reuses an existing unfinished batch instead of minting a new one — see
  // App.tsx's handleCreateRingBraceletBatch doc comment.
  onCreateRingBraceletBatch: (
    sourceDir: string,
    title: string,
    product: 'ring' | 'bracelet',
    resumeBatchId?: string,
  ) => Promise<string>
  // Earring (Phase 12C) — same role as onCreateRingBraceletBatch, no product
  // param needed since there's only one Earring product.
  onCreateEarringBatch: (sourceDir: string, title: string, resumeBatchId?: string) => Promise<string>
  // Hoop Manual boundary placement (Phase 12E) — called instead of starting
  // the job when Manual mode has at least one Hoop SKU present. Carries the
  // already-updated batch detail (from the batch-registry:update-stage call
  // that set status:'configuring') so App.tsx can adopt it directly rather
  // than issuing a second fetch; App.tsx's existing status-driven rendering
  // does the rest (no separate navigation call needed — see App.tsx).
  onEnterHoopBoundaryEditor: (detail: BatchDetailRecord) => void
  // Production/Testing (Phase 13E, Decision — "batch name and mode become
  // fields on the consoles themselves"). Controlled from App.tsx's own
  // pendingMode state, exactly like Preprocessing.tsx — see that screen's
  // identical prop for the full rationale. Watch/BatchSetup doesn't consume
  // this (its own batch-creation path never reads pendingMode, unchanged
  // pre-13E behavior) — it's still passed uniformly for prop-shape
  // consistency, matching how onCreateRingBraceletBatch etc. are already
  // passed to the Watch branch despite not being used there.
  mode: BatchMode
  onModeChange: (mode: BatchMode) => void
}

// The shared Editing setup screen (Phase 10D, extended in 12C, rebuilt as a
// Console in 13E): one product selector, with Watch's BatchSetup, the Ring
// & Bracelet fields, or the Earring fields rendered beneath it depending on
// the current selection. This is the single entry point for all four —
// Home's generic "Editing" launch and each sidebar shortcut all render this
// same component, differing only in which product is preselected (see
// App.tsx).
//
// Watch/BatchSetup got the full Console treatment in a post-Phase-13 pass
// (it was a deliberate reskin-only exception through 13E — see git history
// for that rationale — since lifting it into the two-pane shape was judged
// a functional change at the time; on review the recomposition turned out
// to be layout/chrome-only after all, so it now matches Ring & Bracelet and
// Earring exactly). BatchSetup owns its own ConsoleLayout/ConsoleSummaryPanel
// directly, the same self-contained pattern RingBraceletFields/EarringFields
// below already use — every field, effect, and IPC call inside it is
// unchanged; only where each piece renders moved.
export default function EditingSetup({
  product,
  onProductChange,
  initialBatchName,
  onBeginAnnotation,
  handoffFolder,
  onCreateRingBraceletBatch,
  onCreateEarringBatch,
  onEnterHoopBoundaryEditor,
  mode,
  onModeChange,
}: EditingSetupProps) {
  const productSelector = (
    <div className={styles.productField}>
      <SegmentedControl label="Product" options={PRODUCT_OPTIONS} value={product} onChange={onProductChange} />
    </div>
  )

  if (product === 'watch') {
    return (
      <BatchSetup
        onBeginAnnotation={onBeginAnnotation}
        initialBatchName={initialBatchName}
        handoffFolder={handoffFolder}
        productSelector={productSelector}
      />
    )
  }

  if (product === 'ring' || product === 'bracelet') {
    return (
      <RingBraceletFields
        key={product}
        product={product}
        initialBatchName={initialBatchName}
        handoffFolder={handoffFolder}
        onCreateBatch={onCreateRingBraceletBatch}
        mode={mode}
        onModeChange={onModeChange}
        productSelector={productSelector}
      />
    )
  }

  return (
    <EarringFields
      initialBatchName={initialBatchName}
      handoffFolder={handoffFolder}
      onCreateBatch={onCreateEarringBatch}
      onEnterHoopBoundaryEditor={onEnterHoopBoundaryEditor}
      mode={mode}
      onModeChange={onModeChange}
      productSelector={productSelector}
    />
  )
}

// ── Ring & Bracelet fields ───────────────────────────────────────────────────
// Deliberately its own small block rather than a separate screen file — it's
// a handful of fields (no validation/matching/session concepts like Watch
// has), so a parallel file would be more ceremony than the content warrants.
// Phase 13E: renders its own ConsoleLayout/ConsoleSummaryPanel directly
// (rather than EditingSetup lifting this component's state up to render
// them itself) since this component already owns all the state a summary
// panel needs to restate — the established "self-contained block" pattern
// this file already uses extends naturally to owning its own Console shell.

interface RingBraceletFieldsProps {
  product: 'ring' | 'bracelet'
  initialBatchName: string
  // Preprocessing → Editing hand-off (Phase 10F) — display-only, matching
  // BatchSetup's exact pattern: the actual prefill happens automatically via
  // useRingBraceletFolders' own prefs-restore-on-mount effect (App.tsx
  // writes prefs:save-ring-bracelet-folders before navigating here). This
  // prop only drives the "Prepared ✓" badge once that value has loaded.
  handoffFolder: string | null
  onCreateBatch: (sourceDir: string, title: string, product: 'ring' | 'bracelet', resumeBatchId?: string) => Promise<string>
  mode: BatchMode
  onModeChange: (mode: BatchMode) => void
  productSelector: ReactNode
}

function RingBraceletFields({
  product,
  initialBatchName,
  handoffFolder,
  onCreateBatch,
  mode,
  onModeChange,
  productSelector,
}: RingBraceletFieldsProps) {
  const [batchName, setBatchName] = useState(initialBatchName)
  const [starting, setStarting] = useState(false)
  // Defaults to 'automatic' — matches the pre-11.5C behavior of always
  // running the masking workflow, so an operator who never touches this
  // control sees no change.
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('automatic')
  const [validation, setValidation] = useState<BatchValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  // Prepare Input (Phase 13E, Decision 16) — mirrors handoffFolder's own
  // "matches the current input dir" pattern exactly, just for a prep run
  // triggered from inside this console instead of arriving via the
  // Preprocessing → Editing hand-off dialog.
  const [preparedInputDir, setPreparedInputDir] = useState<string | null>(null)
  // Saved-session parity with Watch (Item 3, post-Phase-13 polish) — Ring &
  // Bracelet has no SessionFile/annotation step, so there's nothing to
  // "resume" in Watch's sense. What genuinely carries over is an unfinished
  // prior batch at these exact input/output/product paths: the Python
  // runner's own idempotent-skip behavior (Phase 11.5D) means re-running
  // against it picks up only the images that didn't already succeed.
  // `null` = none found yet / not checked; only set to a real batch when
  // that batch's editing stage is genuinely unfinished (see the effect
  // below) — a fully completed match means nothing to resume, so no prompt.
  const [existingBatch, setExistingBatch] = useState<BatchDetailRecord | null>(null)
  const folders = useRingBraceletFolders(product)
  const python = usePythonInterpreter()
  const job = useRingBraceletJob()
  const { showToast } = useToast()

  // Phase 11.5D — lightweight pre-flight validation: does the input folder
  // exist and contain at least one image runner.py would actually pick up?
  // Runs automatically whenever the folder changes (picked, dropped, or
  // restored from prefs on mount) rather than behind a separate Validate
  // button — there's nothing else to validate here (no spreadsheet, no
  // SKU matching), so a dedicated step would be more ceremony than the
  // check warrants.
  useEffect(() => {
    if (folders.inputDir === '') {
      setValidation(null)
      return
    }
    let cancelled = false
    setValidating(true)
    window.api.invoke('ring-bracelet:validate-input', { inputDir: folders.inputDir }).then(result => {
      if (!cancelled) {
        setValidation(result)
        setValidating(false)
      }
    })
    return () => { cancelled = true }
  }, [folders.inputDir])

  // Runs once the input folder is valid and an output folder is chosen —
  // mirrors BatchSetup's runValidate → session:load sequencing (session
  // lookup only after the path-level checks pass), just spread across two
  // effects here since Ring & Bracelet's own validation is itself effect-driven
  // rather than a single button call.
  useEffect(() => {
    if (!(validation?.ok === true) || folders.outputDir === '') {
      setExistingBatch(null)
      return
    }
    let cancelled = false
    window.api
      .invoke('batch-registry:find-editing', { product, inputFolder: folders.inputDir, outputFolder: folders.outputDir })
      .then(found => {
        if (cancelled) return
        const stage = found?.stages.find(s => s.type === 'editing')
        const unfinished = stage !== undefined && stage.status !== 'completed'
        setExistingBatch(unfinished ? found : null)
      })
    return () => { cancelled = true }
  }, [product, validation, folders.inputDir, folders.outputDir])

  const showResumePrompt = existingBatch !== null
  const canStart =
    folders.inputDir !== '' &&
    folders.outputDir !== '' &&
    python.isValid &&
    !starting &&
    validation?.ok === true &&
    !showResumePrompt

  async function pickInputDir(explicitPath?: string) {
    if (starting) return
    const path = explicitPath ?? await window.api.invoke('dialog:openFolder', { historyKey: `${product}-input` })
    if (path !== null) folders.setInputDir(path)
  }

  async function pickOutputDir(explicitPath?: string) {
    if (starting) return
    const path = explicitPath ?? await window.api.invoke('dialog:openFolder', { historyKey: `${product}-output` })
    if (path !== null) folders.setOutputDir(path)
  }

  // resumeBatchId set only from ResumePrompt's onResume below — bypasses
  // the canStart gate deliberately (Resume is offered exactly when canStart
  // would otherwise be false, since showResumePrompt is one of its terms).
  //
  // Queueing (Item 5A, post-Phase-13 polish) — see Preprocessing.tsx's
  // identical branch for the full rationale. Applies to Resume too: if a
  // same-type job is already running, Resume queues exactly like a fresh
  // Start rather than failing.
  async function handleStart(resumeBatchId?: string) {
    if (!resumeBatchId && !canStart) return
    setStarting(true)
    setExistingBatch(null)
    const batchId = await onCreateBatch(folders.inputDir, batchName, product, resumeBatchId)
    const overridePath = python.override.trim()
    const payload = {
      inputDir: folders.inputDir,
      outputDir: folders.outputDir,
      batchId,
      product,
      processingMode,
      ...(overridePath !== '' ? { pythonPath: overridePath } : {}),
    }

    if (job.phase === 'running') {
      await window.api.invoke('batch-registry:update-stage', {
        id: batchId,
        stageType: 'editing',
        patch: { status: 'queued', config: { product } },
      })
      job.enqueue(payload)
      showToast({ title: 'Batch queued', description: 'It will start automatically once the current run finishes.' })
      setStarting(false)
      return
    }

    await job.start(payload)
    setStarting(false)
  }

  const isHandoff = handoffFolder !== null && folders.inputDir === handoffFolder
  const isPrepared = preparedInputDir !== null && folders.inputDir === preparedInputDir
  const showPreparedBadge = isHandoff || isPrepared

  const summaryItems: ConsoleSummaryItem[] = [
    { label: 'Images', value: validation?.ok ? String(validation.imageCount) : '—' },
    { label: 'Product', value: product === 'bracelet' ? 'Bracelet' : 'Ring' },
    { label: 'Masking', value: processingMode === 'manual' ? 'Manual' : 'Automatic' },
    { label: 'Mode', value: mode === 'testing' ? 'Testing' : 'Production' },
  ]

  return (
    <ConsoleLayout
      title="Editing"
      subtitle="Choose a product, then configure a new batch."
      headerExtra={productSelector}
      summary={
        <ConsoleSummaryPanel
          items={summaryItems}
          onStart={() => handleStart()}
          startLabel={job.phase === 'running' ? 'Add to Queue' : 'Start'}
          canStart={canStart}
          starting={starting}
          error={job.startError}
          hideStartButton={showResumePrompt}
        >
          {showResumePrompt && existingBatch && (
            <ResumePrompt
              label="Unfinished batch found"
              detail={(() => {
                const stage = existingBatch.stages.find(s => s.type === 'editing')!
                return `${stage.counts.succeeded} of ${stage.counts.total} processed`
              })()}
              onResume={() => handleStart(existingBatch.id)}
              onFresh={() => { setExistingBatch(null); void handleStart() }}
            />
          )}
        </ConsoleSummaryPanel>
      }
    >
      {isHandoff && (
        <p className={styles.handoffMessage}>
          ✓ Input folder prepared from Preprocessing. Choose an output folder to continue.
        </p>
      )}
      <div className={styles.nameRow}>
        <div className={styles.nameField}>
          <label className={styles.nameLabel}>Batch Name (optional)</label>
          <input
            className={styles.nameInput}
            type="text"
            value={batchName}
            onChange={e => setBatchName(e.target.value)}
            placeholder="A name is generated if left blank"
            spellCheck={false}
            disabled={starting}
          />
        </div>
        <SegmentedControl label="Mode" options={MODE_OPTIONS} value={mode} onChange={onModeChange} disabled={starting} />
      </div>
      <PathField
        label="Input Folder"
        value={folders.inputDir}
        placeholder="Select the Universal Preprocessing output folder"
        onPick={() => pickInputDir()}
        onDropPath={pickInputDir}
        disabled={starting}
        badge={showPreparedBadge ? 'Prepared ✓' : undefined}
      />
      {validating && (
        <p className={styles.helperText}>Checking input folder…</p>
      )}
      {!validating && validation && !validation.ok && (
        <div className={styles.errorBanner}>{validation.errors.join(' ')}</div>
      )}
      {!validating && validation?.ok && (
        <p className={styles.helperText}>
          {validation.imageCount} {validation.imageCount === 1 ? 'image' : 'images'} found.
        </p>
      )}
      {!showPreparedBadge && folders.inputDir !== '' && (
        <PrepareInputDisclosure
          sourceDir={folders.inputDir}
          isEarring={false}
          disabled={starting}
          onPrepared={preparedDir => {
            setPreparedInputDir(preparedDir)
            folders.setInputDir(preparedDir)
          }}
        />
      )}
      <PathField
        label="Output Folder"
        value={folders.outputDir}
        placeholder="Select folder for generated assets"
        onPick={() => pickOutputDir()}
        onDropPath={pickOutputDir}
        disabled={starting}
      />
      <SegmentedControl
        label="Masking"
        options={PROCESSING_MODE_OPTIONS}
        value={processingMode}
        onChange={setProcessingMode}
      />
    </ConsoleLayout>
  )
}

// ── Earring fields ───────────────────────────────────────────────────────────
// Mirrors RingBraceletFields' shape (own small block, not a separate screen
// file), plus a metadata-sheet PathField and match/classification summary —
// Earring's Sub-Category-driven type resolution (Phase 12B) has no
// equivalent in Ring & Bracelet's fields.

const EARRING_TYPE_LABELS: Record<EarringType, string> = {
  stud: 'Stud',
  drop: 'Drop',
  hoop: 'Hoop',
}

interface EarringFieldsProps {
  initialBatchName: string
  // See RingBraceletFieldsProps.handoffFolder — same display-only role.
  handoffFolder: string | null
  onCreateBatch: (sourceDir: string, title: string, resumeBatchId?: string) => Promise<string>
  onEnterHoopBoundaryEditor: (detail: BatchDetailRecord) => void
  mode: BatchMode
  onModeChange: (mode: BatchMode) => void
  productSelector: ReactNode
}

function EarringFields({
  initialBatchName,
  handoffFolder,
  onCreateBatch,
  onEnterHoopBoundaryEditor,
  mode,
  onModeChange,
  productSelector,
}: EarringFieldsProps) {
  const [batchName, setBatchName] = useState(initialBatchName)
  const [starting, setStarting] = useState(false)
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('automatic')
  const [validation, setValidation] = useState<BatchValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [match, setMatch] = useState<ProductMetadataLoadResult | null>(null)
  const [matching, setMatching] = useState(false)
  // See RingBraceletFields' identical field for the exact same rationale.
  const [preparedInputDir, setPreparedInputDir] = useState<string | null>(null)
  // See RingBraceletFields' identical field/effect for the full rationale —
  // Earring's product is fixed ('earring') where RingBraceletFields' is a
  // prop, otherwise the same find-editing + "unfinished only" lookup.
  const [existingBatch, setExistingBatch] = useState<BatchDetailRecord | null>(null)
  const folders = useEarringFolders()
  const python = usePythonInterpreter()
  const job = useEarringJob()
  const { showToast } = useToast()

  // Same lightweight pre-flight check as Ring & Bracelet's — folder
  // existence + at least one supported image.
  useEffect(() => {
    if (folders.inputDir === '') {
      setValidation(null)
      return
    }
    let cancelled = false
    setValidating(true)
    window.api.invoke('earring:validate-input', { inputDir: folders.inputDir }).then(result => {
      if (!cancelled) {
        setValidation(result)
        setValidating(false)
      }
    })
    return () => { cancelled = true }
  }, [folders.inputDir])

  // Metadata sheet parse → SKU match → Sub-Category classification (Phase
  // 12B), the first real renderer call to product-metadata:load. Runs
  // whenever either input changes, same automatic-revalidation spirit as the
  // folder check above — there's no separate "Validate" step here either.
  useEffect(() => {
    if (folders.inputDir === '' || folders.metadataFilePath === '') {
      setMatch(null)
      return
    }
    let cancelled = false
    setMatching(true)
    window.api
      .invoke('product-metadata:load', { metadataFilePath: folders.metadataFilePath, inputFolder: folders.inputDir })
      .then(result => {
        if (!cancelled) {
          setMatch(result)
          setMatching(false)
        }
      })
    return () => { cancelled = true }
  }, [folders.inputDir, folders.metadataFilePath])

  // See RingBraceletFields' identical effect for the full rationale.
  useEffect(() => {
    if (!(validation?.ok === true) || folders.outputDir === '') {
      setExistingBatch(null)
      return
    }
    let cancelled = false
    window.api
      .invoke('batch-registry:find-editing', { product: 'earring', inputFolder: folders.inputDir, outputFolder: folders.outputDir })
      .then(found => {
        if (cancelled) return
        const stage = found?.stages.find(s => s.type === 'editing')
        const unfinished = stage !== undefined && stage.status !== 'completed'
        setExistingBatch(unfinished ? found : null)
      })
    return () => { cancelled = true }
  }, [validation, folders.inputDir, folders.outputDir])

  const showResumePrompt = existingBatch !== null
  const canStart =
    folders.inputDir !== '' &&
    folders.outputDir !== '' &&
    folders.metadataFilePath !== '' &&
    python.isValid &&
    !starting &&
    validation?.ok === true &&
    match?.ok === true &&
    !showResumePrompt

  async function pickInputDir(explicitPath?: string) {
    if (starting) return
    const path = explicitPath ?? await window.api.invoke('dialog:openFolder', { historyKey: 'earring-input' })
    if (path !== null) folders.setInputDir(path)
  }

  async function pickOutputDir(explicitPath?: string) {
    if (starting) return
    const path = explicitPath ?? await window.api.invoke('dialog:openFolder', { historyKey: 'earring-output' })
    if (path !== null) folders.setOutputDir(path)
  }

  async function pickMetadataFile(explicitPath?: string) {
    if (starting) return
    const path =
      explicitPath ??
      (await window.api.invoke('dialog:openFile', {
        historyKey: 'earring-metadata',
        filters: [{ name: 'Product Metadata', extensions: ['xlsx', 'csv'] }],
      }))
    if (path !== null) folders.setMetadataFilePath(path)
  }

  // resumeBatchId set only from ResumePrompt's onResume below — see
  // RingBraceletFields' identical function for the full rationale.
  async function handleStart(resumeBatchId?: string) {
    if (!resumeBatchId && !canStart) return
    setStarting(true)
    setExistingBatch(null)
    const batchId = await onCreateBatch(folders.inputDir, batchName, resumeBatchId)

    // Manual mode + at least one Hoop SKU in the matched sheet → the
    // boundary editor, not the job, is next (Phase 12E, Resolved Decision
    // 7: zero hoops behaves identically to Automatic — straight to Run).
    const hoopSkus =
      processingMode === 'manual' && match?.ok && match.classification
        ? Object.keys(match.classification.bySku).filter(sku => match.classification!.bySku[sku] === 'hoop')
        : []

    if (hoopSkus.length > 0) {
      const detail = await window.api.invoke('batch-registry:update-stage', {
        id: batchId,
        stageType: 'editing',
        patch: {
          status: 'configuring',
          inputDir: folders.inputDir,
          outputDir: folders.outputDir,
          config: {
            product: 'earring',
            metadataFilePath: folders.metadataFilePath,
            processingMode,
            hoopSkus,
            hoopSplits: {},
          },
        },
      })
      if (detail) onEnterHoopBoundaryEditor(detail)
      setStarting(false)
      return
    }

    const overridePath = python.override.trim()
    const payload = {
      inputDir: folders.inputDir,
      outputDir: folders.outputDir,
      batchId,
      metadataFilePath: folders.metadataFilePath,
      processingMode,
      ...(overridePath !== '' ? { pythonPath: overridePath } : {}),
    }

    // Queueing (Item 5A, post-Phase-13 polish) — see Preprocessing.tsx's
    // identical branch for the full rationale. Only reachable here (not the
    // Hoop Manual branch above, which hands off to the boundary editor
    // instead of starting a job directly).
    if (job.phase === 'running') {
      await window.api.invoke('batch-registry:update-stage', {
        id: batchId,
        stageType: 'editing',
        patch: { status: 'queued', config: { product: 'earring' } },
      })
      job.enqueue(payload)
      showToast({ title: 'Batch queued', description: 'It will start automatically once the current run finishes.' })
      setStarting(false)
      return
    }

    await job.start(payload)
    setStarting(false)
  }

  const isHandoff = handoffFolder !== null && folders.inputDir === handoffFolder
  const isPrepared = preparedInputDir !== null && folders.inputDir === preparedInputDir
  const showPreparedBadge = isHandoff || isPrepared

  const typeCounts: Record<EarringType, number> = { stud: 0, drop: 0, hoop: 0 }
  if (match?.ok && match.classification) {
    for (const sku of Object.keys(match.classification.bySku)) {
      typeCounts[match.classification.bySku[sku]] += 1
    }
  }
  const typeCountsLabel = (Object.keys(typeCounts) as EarringType[])
    .filter(type => typeCounts[type] > 0)
    .map(type => `${typeCounts[type]} ${EARRING_TYPE_LABELS[type]}`)
    .join(', ')

  const summaryItems: ConsoleSummaryItem[] = [
    { label: 'Images', value: validation?.ok ? String(validation.imageCount) : '—' },
    ...(typeCountsLabel !== '' ? [{ label: 'Types', value: typeCountsLabel }] : []),
    { label: 'Masking', value: processingMode === 'manual' ? 'Manual' : 'Automatic' },
    { label: 'Mode', value: mode === 'testing' ? 'Testing' : 'Production' },
  ]

  return (
    <ConsoleLayout
      title="Editing"
      subtitle="Choose a product, then configure a new batch."
      headerExtra={productSelector}
      summary={
        <ConsoleSummaryPanel
          items={summaryItems}
          onStart={() => handleStart()}
          startLabel={job.phase === 'running' ? 'Add to Queue' : 'Start'}
          canStart={canStart}
          starting={starting}
          error={job.startError}
          hideStartButton={showResumePrompt}
        >
          {match && <EarringMatchSummary result={match} />}
          {showResumePrompt && existingBatch && (
            <ResumePrompt
              label="Unfinished batch found"
              detail={(() => {
                const stage = existingBatch.stages.find(s => s.type === 'editing')!
                return `${stage.counts.succeeded} of ${stage.counts.total} processed`
              })()}
              onResume={() => handleStart(existingBatch.id)}
              onFresh={() => { setExistingBatch(null); void handleStart() }}
            />
          )}
        </ConsoleSummaryPanel>
      }
    >
      {isHandoff && (
        <p className={styles.handoffMessage}>
          ✓ Input folder prepared from Preprocessing. Choose a metadata sheet and output folder to continue.
        </p>
      )}
      <div className={styles.nameRow}>
        <div className={styles.nameField}>
          <label className={styles.nameLabel}>Batch Name (optional)</label>
          <input
            className={styles.nameInput}
            type="text"
            value={batchName}
            onChange={e => setBatchName(e.target.value)}
            placeholder="A name is generated if left blank"
            spellCheck={false}
            disabled={starting}
          />
        </div>
        <SegmentedControl label="Mode" options={MODE_OPTIONS} value={mode} onChange={onModeChange} disabled={starting} />
      </div>
      <PathField
        label="Input Folder"
        value={folders.inputDir}
        placeholder="Select the Universal Preprocessing output folder"
        onPick={() => pickInputDir()}
        onDropPath={pickInputDir}
        disabled={starting}
        badge={showPreparedBadge ? 'Prepared ✓' : undefined}
      />
      {validating && (
        <p className={styles.helperText}>Checking input folder…</p>
      )}
      {!validating && validation && !validation.ok && (
        <div className={styles.errorBanner}>{validation.errors.join(' ')}</div>
      )}
      {!validating && validation?.ok && (
        <p className={styles.helperText}>
          {validation.imageCount} {validation.imageCount === 1 ? 'image' : 'images'} found.
        </p>
      )}
      {!showPreparedBadge && folders.inputDir !== '' && (
        <PrepareInputDisclosure
          sourceDir={folders.inputDir}
          isEarring
          disabled={starting}
          onPrepared={preparedDir => {
            setPreparedInputDir(preparedDir)
            folders.setInputDir(preparedDir)
          }}
        />
      )}
      <PathField
        label="Product Metadata Sheet"
        value={folders.metadataFilePath}
        placeholder="Select the SKU / Category / Sub-Category / Dimensions sheet"
        onPick={() => pickMetadataFile()}
        onDropPath={pickMetadataFile}
        disabled={starting}
      />
      {matching && <p className={styles.helperText}>Matching metadata…</p>}
      {!matching && match && !match.ok && <div className={styles.errorBanner}>{match.errors.join(' ')}</div>}
      <PathField
        label="Output Folder"
        value={folders.outputDir}
        placeholder="Select folder for generated assets"
        onPick={() => pickOutputDir()}
        onDropPath={pickOutputDir}
        disabled={starting}
      />
      <SegmentedControl
        label="Masking"
        options={PROCESSING_MODE_OPTIONS}
        value={processingMode}
        onChange={setProcessingMode}
      />
    </ConsoleLayout>
  )
}

function EarringMatchSummary({ result }: { result: ProductMetadataLoadResult }) {
  if (!result.ok) return null

  const m = result.match
  const classification = result.classification
  if (!m || !classification) return null

  const hasWarnings =
    m.missingImages.length > 0 ||
    m.missingMetadataRecords.length > 0 ||
    m.duplicateMetadataSkus.length > 0 ||
    m.duplicateImageSkus.length > 0 ||
    classification.unmapped.length > 0

  if (!hasWarnings) return null

  return (
    <div className={styles.matchSummary}>
      {m.missingImages.length > 0 && (
        <p className={styles.helperText}>{m.missingImages.length} metadata records with no matching image.</p>
      )}
      {m.missingMetadataRecords.length > 0 && (
        <p className={styles.helperText}>{m.missingMetadataRecords.length} images with no metadata record.</p>
      )}
      {m.duplicateMetadataSkus.length > 0 && (
        <p className={styles.helperText}>{m.duplicateMetadataSkus.length} duplicate SKUs in metadata sheet.</p>
      )}
      {m.duplicateImageSkus.length > 0 && (
        <p className={styles.helperText}>{m.duplicateImageSkus.length} duplicate image SKUs.</p>
      )}
      {classification.unmapped.length > 0 && (
        <div className={styles.unmappedList}>
          <div className={styles.helperText}>
            {classification.unmapped.length} matched {classification.unmapped.length === 1 ? 'SKU has' : 'SKUs have'} an unrecognized Sub-Category (expected stud/studs, drop/drops, or hoop/hoops):
          </div>
          {classification.unmapped.map(sku => (
            <div key={sku} className={styles.unmappedItem}>{sku} — "{m.rows[sku]?.subCategory ?? ''}"</div>
          ))}
        </div>
      )}
    </div>
  )
}
