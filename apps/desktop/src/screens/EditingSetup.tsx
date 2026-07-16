import { useState } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { PathField } from '../components/PathField'
import BatchSetup from './BatchSetup'
import { useRingBraceletFolders } from '../hooks/useRingBraceletFolders'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useRingBraceletJob } from '../context/RingBraceletJobContext'
import type { BatchState } from '../types/annotation'
import type { SessionFile } from '../types/session'
import type { EditingProduct } from '../types/navigation'
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
          <Select
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
  onCreateBatch: (sourceDir: string, title: string, product: 'ring' | 'bracelet') => Promise<string>
}

function RingBraceletFields({ product, initialBatchName, onCreateBatch }: RingBraceletFieldsProps) {
  const [batchName, setBatchName] = useState(initialBatchName)
  const [starting, setStarting] = useState(false)
  const folders = useRingBraceletFolders(product)
  const python = usePythonInterpreter()
  const job = useRingBraceletJob()

  const canStart = folders.inputDir !== '' && folders.outputDir !== '' && python.isValid && !starting

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
      ...(overridePath !== '' ? { pythonPath: overridePath } : {}),
    })
    setStarting(false)
  }

  return (
    <div className={styles.fields}>
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
      />
      <PathField
        label="Output Folder"
        value={folders.outputDir}
        placeholder="Select folder for generated assets"
        onPick={() => pickOutputDir()}
        onDropPath={pickOutputDir}
        disabled={starting}
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
