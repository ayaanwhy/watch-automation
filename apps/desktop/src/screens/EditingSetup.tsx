import { useEffect, useState } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { PathField } from '../components/PathField'
import BatchSetup from './BatchSetup'
import { useRingBraceletFolders } from '../hooks/useRingBraceletFolders'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useRingBraceletJob } from '../context/RingBraceletJobContext'
import { PROCESSING_MODE_OPTIONS } from '../constants/processingMode'
import type { ProcessingMode } from '../constants/processingMode'
import type { BatchState } from '../types/annotation'
import type { SessionFile } from '../types/session'
import type { EditingProduct } from '../types/navigation'
import type { BatchValidationResult } from '../types/ipc'
import styles from './EditingSetup.module.css'

// Earrings is listed and disabled rather than omitted, matching the
// sidebar's existing "Soon" convention for roadmap products that don't have
// a workflow yet.
type ProductOption = EditingProduct | 'earring'

const PRODUCT_OPTIONS: { value: ProductOption; label: string; disabled?: boolean }[] = [
  { value: 'watch', label: 'Watch' },
  { value: 'ring', label: 'Ring' },
  { value: 'bracelet', label: 'Bracelet' },
  { value: 'earring', label: 'Earrings', disabled: true },
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
}

// The shared Editing setup screen (Phase 10D): one product selector, with
// Watch's existing BatchSetup or the Ring & Bracelet fields rendered beneath
// it depending on the current selection. This is the single entry point for
// all three — Home's generic "Editing" launch and each sidebar shortcut
// (Watches/Rings/Bracelets) all render this same component, differing only
// in which product is preselected (see App.tsx).
export default function EditingSetup({
  product,
  onProductChange,
  initialBatchName,
  onBeginAnnotation,
  handoffFolder,
  onCreateRingBraceletBatch,
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
            onChange={next => {
              if (next !== 'earring') onProductChange(next)
            }}
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
