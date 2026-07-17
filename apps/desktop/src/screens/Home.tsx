import { useEffect, useState } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { BatchCard } from '../components/batch/BatchCard'
import { CreateBatchModal } from '../components/batch/CreateBatchModal'
import type { BatchMode, BatchSummaryRecord } from '../types/batch'
import styles from './Home.module.css'

// Home's own entry-id vocabulary — no longer maps 1:1 onto a resolved
// pipeline (Phase 10D): 'editing' can't resolve to a StageType[] yet, since
// which product (and therefore which stage type — 'watch' or 'editing') is
// chosen on the next screen, not here. See App.tsx's handleLaunchFromHome.
// Exported so CreateBatchModal (Phase 10F) shares this exact vocabulary
// rather than redeclaring it.
export type HomeEntryId = 'preprocessing' | 'editing'

interface HomeProps {
  // Navigates into the chosen entry's screen with an optional custom title
  // and mode. No Batch is created here — creation happens at the workflow's
  // execution action (Start / Begin Annotation), so this produces the exact
  // same downstream result as entering the same workflow via the sidebar
  // (which always defaults to Production — see App.tsx's navigate()).
  onLaunch: (entry: HomeEntryId, title: string, mode: BatchMode) => void
  // Reopens an existing batch (Phase 9E) — an in-progress batch reopens into
  // its live stage; a finished one opens the permanent Batch Details screen.
  onOpenBatch: (id: string) => void
}

type ModeFilter = 'all' | BatchMode

const MODE_FILTER_OPTIONS: { value: ModeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'production', label: 'Production' },
  { value: 'testing', label: 'Testing' },
]

// Home — the execution-history landing screen and the entry point back into
// previous work.
export default function Home({ onLaunch, onOpenBatch }: HomeProps) {
  const [batches, setBatches] = useState<BatchSummaryRecord[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')

  useEffect(() => {
    void window.api.invoke('batch-registry:list').then(setBatches)
  }, [])

  function handleCreate(entry: HomeEntryId, title: string, mode: BatchMode) {
    onLaunch(entry, title, mode)
    setShowCreateModal(false)
  }

  function handleRenamed(updated: BatchSummaryRecord) {
    setBatches(prev => prev.map(b => (b.id === updated.id ? updated : b)))
  }

  function handleDeleted(id: string) {
    setBatches(prev => prev.filter(b => b.id !== id))
  }

  // Client-side only — batch-registry:list already returns everything and
  // the dataset is small (per-user execution history, not a shared table),
  // so a filter IPC parameter would be pure ceremony for no benefit.
  const visibleBatches =
    modeFilter === 'all' ? batches : batches.filter(b => (b.mode ?? 'production') === modeFilter)

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <PageHeader
          sticky
          title="Home"
          subtitle="Your batches — create a new one or reopen previous work."
          actions={<Button onClick={() => setShowCreateModal(true)}>New Batch</Button>}
        />

        {showCreateModal && (
          <CreateBatchModal onCreate={handleCreate} onClose={() => setShowCreateModal(false)} />
        )}

        {batches.length > 0 && (
          <SegmentedControl
            className={styles.modeFilter}
            aria-label="Filter by mode"
            options={MODE_FILTER_OPTIONS}
            value={modeFilter}
            onChange={setModeFilter}
          />
        )}

        {visibleBatches.length === 0 ? (
          <div className={styles.empty}>
            {batches.length === 0
              ? 'No batches yet. Create one to get started.'
              : 'No batches match this filter.'}
          </div>
        ) : (
          <div className={styles.list}>
            {visibleBatches.map(b => (
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
