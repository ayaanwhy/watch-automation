import { useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { SegmentedControl } from '../ui/SegmentedControl'
import type { BatchMode } from '../../types/batch'
import type { HomeEntryId } from '../../screens/Home'
import styles from './CreateBatchModal.module.css'

interface CreateBatchModalProps {
  onCreate: (entry: HomeEntryId, title: string, mode: BatchMode) => void
  onClose: () => void
}

const ENTRIES: { id: HomeEntryId; title: string; description: string }[] = [
  {
    id: 'preprocessing',
    title: 'Preprocessing',
    description: 'Background removal, segmentation, and upscaling of raw imagery.',
  },
  {
    id: 'editing',
    title: 'Editing',
    description: 'Generate finished assets for Watch, Ring, or Bracelet products.',
  },
]

const MODE_OPTIONS: { value: BatchMode; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'testing', label: 'Testing' },
]

// The Home "New Batch" flow (Phase 10F), moved off the page into a modal —
// same fields/behavior as the inline panel it replaces, just relocated onto
// the shared Modal primitive. No Batch is created here; like the flow it
// replaces, this only navigates into the chosen entry's setup screen with a
// title + mode, and the real batch-registry:create call happens later at
// that screen's own Start/Begin Annotation action.
export function CreateBatchModal({ onCreate, onClose }: CreateBatchModalProps) {
  const [entry, setEntry] = useState<HomeEntryId>('preprocessing')
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<BatchMode>('production')

  function handleCreate() {
    onCreate(entry, title.trim(), mode)
  }

  return (
    <Modal
      title="New Batch"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate}>Create & Open</Button>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.entryGrid}>
          {ENTRIES.map(e => (
            <button
              key={e.id}
              type="button"
              className={`${styles.entryCard} ${entry === e.id ? styles.entryCardActive : ''}`}
              onClick={() => setEntry(e.id)}
              aria-pressed={entry === e.id}
            >
              <span className={styles.entryTitle}>{e.title}</span>
              <span className={styles.entryDescription}>{e.description}</span>
            </button>
          ))}
        </div>

        <input
          className={styles.titleInput}
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Batch name (optional — a name is generated if left blank)"
          spellCheck={false}
          autoFocus
        />

        <SegmentedControl
          label="Mode"
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
        />
      </div>
    </Modal>
  )
}
