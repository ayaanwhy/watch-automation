import { useEffect, useState } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { PathField } from '../components/PathField'
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
import type { BatchDetailRecord } from '../types/batch'
import type { EarringType } from '../constants/earringClassification'
import styles from './EditingSetup.module.css'

const PRODUCT_OPTIONS: { value: EditingProduct; label: string }[] = [
  { value: 'watch', label: 'Watch' },
  { value: 'ring', label: 'Ring' },
  { value: 'bracelet', label: 'Bracelet' },
  { value: 'earring', label: 'Earring' },
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
  // forwarded to the runner.
  onCreateRingBraceletBatch: (sourceDir: string, title: string, product: 'ring' | 'bracelet') => Promise<string>
  // Earring (Phase 12C) — same role as onCreateRingBraceletBatch, no product
  // param needed since there's only one Earring product.
  onCreateEarringBatch: (sourceDir: string, title: string) => Promise<string>
  // Hoop Manual boundary placement (Phase 12E) — called instead of starting
  // the job when Manual mode has at least one Hoop SKU present. Carries the
  // already-updated batch detail (from the batch-registry:update-stage call
  // that set status:'configuring') so App.tsx can adopt it directly rather
  // than issuing a second fetch; App.tsx's existing status-driven rendering
  // does the rest (no separate navigation call needed — see App.tsx).
  onEnterHoopBoundaryEditor: (detail: BatchDetailRecord) => void
}

// The shared Editing setup screen (Phase 10D, extended in 12C): one product
// selector, with Watch's existing BatchSetup, the Ring & Bracelet fields, or
// the Earring fields rendered beneath it depending on the current selection.
// This is the single entry point for all four — Home's generic "Editing"
// launch and each sidebar shortcut all render this same component, differing
// only in which product is preselected (see App.tsx).
export default function EditingSetup({
  product,
  onProductChange,
  initialBatchName,
  onBeginAnnotation,
  handoffFolder,
  onCreateRingBraceletBatch,
  onCreateEarringBatch,
  onEnterHoopBoundaryEditor,
}: EditingSetupProps) {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <PageHeader title="Editing" subtitle="Choose a product, then configure a new batch." />

        <div className={styles.productField}>
          <SegmentedControl
            label="Product"
            options={PRODUCT_OPTIONS}
            value={product}
            onChange={onProductChange}
          />
        </div>

        {product === 'watch' && (
          <BatchSetup
            onBeginAnnotation={onBeginAnnotation}
            initialBatchName={initialBatchName}
            handoffFolder={handoffFolder}
          />
        )}

        {(product === 'ring' || product === 'bracelet') && (
          <RingBraceletFields
            key={product}
            product={product}
            initialBatchName={initialBatchName}
            handoffFolder={handoffFolder}
            onCreateBatch={onCreateRingBraceletBatch}
          />
        )}

        {product === 'earring' && (
          <EarringFields
            initialBatchName={initialBatchName}
            handoffFolder={handoffFolder}
            onCreateBatch={onCreateEarringBatch}
            onEnterHoopBoundaryEditor={onEnterHoopBoundaryEditor}
          />
        )}
      </div>
    </div>
  )
}

// ── Ring & Bracelet fields ───────────────────────────────────────────────────
// Deliberately its own small block rather than a separate screen file — it's
// a handful of fields (no validation/matching/session concepts like Watch
// has), so a parallel file would be more ceremony than the content warrants.

interface RingBraceletFieldsProps {
  product: 'ring' | 'bracelet'
  initialBatchName: string
  // Preprocessing → Editing hand-off (Phase 10F) — display-only, matching
  // BatchSetup's exact pattern: the actual prefill happens automatically via
  // useRingBraceletFolders' own prefs-restore-on-mount effect (App.tsx
  // writes prefs:save-ring-bracelet-folders before navigating here). This
  // prop only drives the "Prepared ✓" badge once that value has loaded.
  handoffFolder: string | null
  onCreateBatch: (sourceDir: string, title: string, product: 'ring' | 'bracelet') => Promise<string>
}

function RingBraceletFields({ product, initialBatchName, handoffFolder, onCreateBatch }: RingBraceletFieldsProps) {
  const [batchName, setBatchName] = useState(initialBatchName)
  const [starting, setStarting] = useState(false)
  // Defaults to 'automatic' — matches the pre-11.5C behavior of always
  // running the masking workflow, so an operator who never touches this
  // control sees no change.
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('automatic')
  const [validation, setValidation] = useState<BatchValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const folders = useRingBraceletFolders(product)
  const python = usePythonInterpreter()
  const job = useRingBraceletJob()

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

  const canStart = folders.inputDir !== '' && folders.outputDir !== '' && python.isValid && !starting && validation?.ok === true

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

  async function handleStart() {
    if (!canStart) return
    setStarting(true)
    const batchId = await onCreateBatch(folders.inputDir, batchName, product)
    const overridePath = python.override.trim()
    await job.start({
      inputDir: folders.inputDir,
      outputDir: folders.outputDir,
      batchId,
      product,
      processingMode,
      ...(overridePath !== '' ? { pythonPath: overridePath } : {}),
    })
    setStarting(false)
  }

  const isHandoff = handoffFolder !== null && folders.inputDir === handoffFolder

  return (
    <div className={styles.fields}>
      {isHandoff && (
        <p className={styles.handoffMessage}>
          ✓ Input folder prepared from Preprocessing. Choose an output folder to continue.
        </p>
      )}
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
      <PathField
        label="Input Folder"
        value={folders.inputDir}
        placeholder="Select the Universal Preprocessing output folder"
        onPick={() => pickInputDir()}
        onDropPath={pickInputDir}
        disabled={starting}
        badge={isHandoff ? 'Prepared ✓' : undefined}
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
      <PathField
        label="Output Folder"
        value={folders.outputDir}
        placeholder="Select folder for generated assets"
        onPick={() => pickOutputDir()}
        onDropPath={pickOutputDir}
        disabled={starting}
      />
      <SegmentedControl
        label="Mode"
        options={PROCESSING_MODE_OPTIONS}
        value={processingMode}
        onChange={setProcessingMode}
      />

      {job.startError && <div className={styles.errorBanner}>{job.startError}</div>}

      <div className={styles.actions}>
        <button className={styles.startButton} onClick={handleStart} disabled={!canStart}>
          {starting ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
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
  onCreateBatch: (sourceDir: string, title: string) => Promise<string>
  onEnterHoopBoundaryEditor: (detail: BatchDetailRecord) => void
}

function EarringFields({ initialBatchName, handoffFolder, onCreateBatch, onEnterHoopBoundaryEditor }: EarringFieldsProps) {
  const [batchName, setBatchName] = useState(initialBatchName)
  const [starting, setStarting] = useState(false)
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('automatic')
  const [validation, setValidation] = useState<BatchValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [match, setMatch] = useState<ProductMetadataLoadResult | null>(null)
  const [matching, setMatching] = useState(false)
  const folders = useEarringFolders()
  const python = usePythonInterpreter()
  const job = useEarringJob()

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

  const canStart =
    folders.inputDir !== '' &&
    folders.outputDir !== '' &&
    folders.metadataFilePath !== '' &&
    python.isValid &&
    !starting &&
    validation?.ok === true &&
    match?.ok === true

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

  async function handleStart() {
    if (!canStart) return
    setStarting(true)
    const batchId = await onCreateBatch(folders.inputDir, batchName)

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
    await job.start({
      inputDir: folders.inputDir,
      outputDir: folders.outputDir,
      batchId,
      metadataFilePath: folders.metadataFilePath,
      processingMode,
      ...(overridePath !== '' ? { pythonPath: overridePath } : {}),
    })
    setStarting(false)
  }

  const isHandoff = handoffFolder !== null && folders.inputDir === handoffFolder

  return (
    <div className={styles.fields}>
      {isHandoff && (
        <p className={styles.handoffMessage}>
          ✓ Input folder prepared from Preprocessing. Choose a metadata sheet and output folder to continue.
        </p>
      )}
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
      <PathField
        label="Input Folder"
        value={folders.inputDir}
        placeholder="Select the Universal Preprocessing output folder"
        onPick={() => pickInputDir()}
        onDropPath={pickInputDir}
        disabled={starting}
        badge={isHandoff ? 'Prepared ✓' : undefined}
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
      <PathField
        label="Product Metadata Sheet"
        value={folders.metadataFilePath}
        placeholder="Select the SKU / Category / Sub-Category / Dimensions sheet"
        onPick={() => pickMetadataFile()}
        onDropPath={pickMetadataFile}
        disabled={starting}
      />
      {matching && <p className={styles.helperText}>Matching metadata…</p>}
      {!matching && match && <EarringMatchSummary result={match} />}
      <PathField
        label="Output Folder"
        value={folders.outputDir}
        placeholder="Select folder for generated assets"
        onPick={() => pickOutputDir()}
        onDropPath={pickOutputDir}
        disabled={starting}
      />
      <SegmentedControl
        label="Mode"
        options={PROCESSING_MODE_OPTIONS}
        value={processingMode}
        onChange={setProcessingMode}
      />

      {job.startError && <div className={styles.errorBanner}>{job.startError}</div>}

      <div className={styles.actions}>
        <button className={styles.startButton} onClick={handleStart} disabled={!canStart}>
          {starting ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
  )
}

function EarringMatchSummary({ result }: { result: ProductMetadataLoadResult }) {
  if (!result.ok) {
    return <div className={styles.errorBanner}>{result.errors.join(' ')}</div>
  }

  const m = result.match
  const classification = result.classification
  if (!m || !classification) return null

  const counts: Record<EarringType, number> = { stud: 0, drop: 0, hoop: 0 }
  for (const sku of Object.keys(classification.bySku)) {
    counts[classification.bySku[sku]] += 1
  }

  const hasWarnings =
    m.missingImages.length > 0 ||
    m.missingMetadataRecords.length > 0 ||
    m.duplicateMetadataSkus.length > 0 ||
    m.duplicateImageSkus.length > 0 ||
    classification.unmapped.length > 0

  return (
    <div className={`${styles.matchSummary} ${hasWarnings ? styles.matchSummaryWarn : styles.matchSummaryOk}`}>
      <div className={styles.matchSummaryRow}>
        <span>{m.matched.length} matched</span>
        {(Object.keys(counts) as EarringType[])
          .filter(type => counts[type] > 0)
          .map(type => (
            <span key={type}>{counts[type]} {EARRING_TYPE_LABELS[type]}</span>
          ))}
      </div>
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
