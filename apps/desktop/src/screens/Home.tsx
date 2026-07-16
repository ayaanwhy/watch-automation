import { useEffect, useState } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { BatchCard } from '../components/batch/BatchCard'
import type { BatchSummaryRecord } from '../types/batch'
import styles from './Home.module.css'

// Home's own entry-id vocabulary — no longer maps 1:1 onto a resolved
// pipeline (Phase 10D): 'editing' can't resolve to a StageType[] yet, since
// which product (and therefore which stage type — 'watch' or 'editing') is
// chosen on the next screen, not here. See App.tsx's handleLaunchFromHome.
type HomeEntryId = 'preprocessing' | 'editing'

interface HomeProps {
  // Navigates into the chosen entry's screen with an optional custom title.
  // No Batch is created here — creation happens at the workflow's execution
  // action (Start / Begin Annotation), so this produces the exact same
  // downstream result as entering the same workflow via the sidebar.
  onLaunch: (entry: HomeEntryId, title: string) => void
  // Reopens an existing batch (Phase 9E) — an in-progress batch reopens into
  // its live stage; a finished one opens the permanent Batch Details screen.
  onOpenBatch: (id: string) => void
}

// Phase 10D — Watch Processing is no longer its own entry; Editing (Watch,
// Ring, Bracelet — product chosen on the next screen) replaces it.
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

// Home — the execution-history landing screen and the entry point back into
// previous work.
export default function Home({ onLaunch, onOpenBatch }: HomeProps) {
  const [batches, setBatches] = useState<BatchSummaryRecord[]>([])
  const [creating, setCreating] = useState(false)
  const [entry, setEntry] = useState<HomeEntryId>('preprocessing')
  const [title, setTitle] = useState('')

  useEffect(() => {
    void window.api.invoke('batch-registry:list').then(setBatches)
  }, [])

  function handleCreate() {
    onLaunch(entry, title.trim())
    setCreating(false)
    setTitle('')
    setEntry('preprocessing')
  }

  function handleRenamed(updated: BatchSummaryRecord) {
    setBatches(prev => prev.map(b => (b.id === updated.id ? updated : b)))
  }

  function handleDeleted(id: string) {
    setBatches(prev => prev.filter(b => b.id !== id))
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <PageHeader
          sticky
          title="Home"
          subtitle="Your batches — create a new one or reopen previous work."
          actions={
            !creating ? (
              <Button onClick={() => setCreating(true)}>New Batch</Button>
            ) : undefined
          }
        />

        {creating && (
          <Card className={styles.createPanel}>
            <div className={styles.createHeading}>New Batch</div>

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
            />

            <div className={styles.createActions}>
              <Button onClick={handleCreate}>Create & Open</Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </Card>
        )}

        {batches.length === 0 ? (
          <div className={styles.empty}>No batches yet. Create one to get started.</div>
        ) : (
          <div className={styles.list}>
            {batches.map(b => (
              <BatchCard
                key={b.id}
                batch={b}
                onOpen={() => onOpenBatch(b.id)}
                onRenamed={handleRenamed}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
