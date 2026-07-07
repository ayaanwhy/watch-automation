import { useEffect, useState } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { BatchCard } from '../components/batch/BatchCard'
import { PIPELINE_TEMPLATES } from '../types/batch'
import type { BatchEntry, BatchSummaryRecord, StageType } from '../types/batch'
import styles from './Home.module.css'

interface HomeProps {
  // Stashes the chosen pipeline/title and navigates into the first stage's
  // screen. No Batch is created here — creation happens at the workflow's
  // execution action (Start / Begin Annotation), so this produces the exact
  // same downstream result as entering the same workflow via the sidebar.
  onLaunch: (pipeline: StageType[], title: string) => void
}

// The two single-stage batch types functional in 9B. Full-pipeline
// (Preprocessing → Watch Processing) with stage transitions arrives in 9C.
const ENTRIES: { id: BatchEntry; title: string; description: string }[] = [
  {
    id: 'preprocessing',
    title: 'Preprocessing',
    description: 'Background removal, segmentation, and upscaling of raw imagery.',
  },
  {
    id: 'watch',
    title: 'Watch Processing',
    description: 'Match, annotate, and export a batch of measured watch images.',
  },
]

// Home — the execution-history landing screen and the entry point back into
// previous work.
export default function Home({ onLaunch }: HomeProps) {
  const [batches, setBatches] = useState<BatchSummaryRecord[]>([])
  const [creating, setCreating] = useState(false)
  const [entry, setEntry] = useState<BatchEntry>('preprocessing')
  const [title, setTitle] = useState('')

  useEffect(() => {
    void window.api.invoke('batch-registry:list').then(setBatches)
  }, [])

  function handleCreate() {
    onLaunch(PIPELINE_TEMPLATES[entry], title.trim())
    setCreating(false)
    setTitle('')
    setEntry('preprocessing')
  }

  function handleRenamed(updated: BatchSummaryRecord) {
    setBatches(prev => prev.map(b => (b.id === updated.id ? updated : b)))
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <PageHeader
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
              <BatchCard key={b.id} batch={b} onRenamed={handleRenamed} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
