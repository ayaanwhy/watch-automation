import { useMemo, useState } from 'react'
import { useAnnotation } from '../context/AnnotationContext'
import { useQueue } from '../context/QueueContext'
import type { QueueStatus } from '../types/ipc'
import styles from './BatchDashboard.module.css'

type FilterKey = 'all' | 'unannotated' | 'annotated' | 'queued' | 'complete' | 'failed'
type SortKey = 'sku' | 'annotation' | 'processing'
type SortDir = 'asc' | 'desc'

const FILTER_LABELS: Record<FilterKey, string> = {
  all: 'All',
  unannotated: 'Unannotated',
  annotated: 'Annotated',
  queued: 'Queued',
  complete: 'Complete',
  failed: 'Failed',
}

const ANNOTATION_ORDER: Record<string, number> = {
  unannotated: 0,
  annotated: 1,
}

const PROCESSING_ORDER: Record<string, number> = {
  '': 0,
  pending: 1,
  queued: 2,
  processing: 3,
  complete: 4,
  failed: 5,
}

const ANNOTATION_LABELS: Record<string, string> = {
  unannotated: 'Unannotated',
  annotated: 'Annotated',
}

const PROCESSING_LABELS: Record<QueueStatus, string> = {
  pending: 'Queuing…',
  queued: 'Queued',
  processing: 'Processing…',
  complete: 'Complete',
  failed: 'Failed',
}

interface DashboardRow {
  index: number
  sku: string
  annotationStatus: string
  processingStatus: QueueStatus | null
}

interface Props {
  onBack(): void
}

export function BatchDashboard({ onBack }: Props) {
  const { annotations, jumpTo } = useAnnotation()
  const { items: queueItems } = useQueue()

  const [filter, setFilter] = useState<FilterKey>('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('sku')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const queueMap = useMemo(() => {
    const map = new Map<string, QueueStatus>()
    for (const item of queueItems) {
      map.set(item.sku, item.status)
    }
    return map
  }, [queueItems])

  const total = annotations.length
  const annotatedCount = annotations.filter(a => a.status === 'annotated').length
  const queuedCount = queueItems.filter(i => i.status === 'queued' || i.status === 'pending').length
  const processingCount = queueItems.filter(i => i.status === 'processing').length
  const completeCount = queueItems.filter(i => i.status === 'complete').length
  const failedCount = queueItems.filter(i => i.status === 'failed').length

  const allRows: DashboardRow[] = useMemo(
    () =>
      annotations.map((a, index) => ({
        index,
        sku: a.sku,
        annotationStatus: a.status,
        processingStatus: queueMap.get(a.sku) ?? null,
      })),
    [annotations, queueMap]
  )

  const filteredRows = useMemo(() => {
    let rows = allRows
    switch (filter) {
      case 'unannotated':
        rows = rows.filter(r => r.annotationStatus === 'unannotated')
        break
      case 'annotated':
        rows = rows.filter(r => r.annotationStatus === 'annotated')
        break
      case 'queued':
        rows = rows.filter(r => r.processingStatus === 'queued' || r.processingStatus === 'pending')
        break
      case 'complete':
        rows = rows.filter(r => r.processingStatus === 'complete')
        break
      case 'failed':
        rows = rows.filter(r => r.processingStatus === 'failed')
        break
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(r => r.sku.toLowerCase().includes(q))
    }
    return rows
  }, [allRows, filter, search])

  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows]
    sorted.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'sku') {
        cmp = a.sku.localeCompare(b.sku)
      } else if (sortKey === 'annotation') {
        cmp = (ANNOTATION_ORDER[a.annotationStatus] ?? 0) - (ANNOTATION_ORDER[b.annotationStatus] ?? 0)
      } else {
        cmp =
          (PROCESSING_ORDER[a.processingStatus ?? ''] ?? 0) -
          (PROCESSING_ORDER[b.processingStatus ?? ''] ?? 0)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [filteredRows, sortKey, sortDir])

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  function handleJump(index: number) {
    jumpTo(index)
    onBack()
  }

  function SortIndicator({ col }: { col: SortKey }) {
    if (sortKey !== col) return <span className={styles.sortInactive}>↕</span>
    return <span className={styles.sortActive}>{sortDir === 'asc' ? '▲' : '▼'}</span>
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onBack}>
          ← Annotation
        </button>
        <h2 className={styles.title}>Batch Overview</h2>
      </div>

      <div className={styles.stats}>
        <StatCard label="Total" value={total} />
        <StatCard label="Annotated" value={annotatedCount} />
        <StatCard label="Queued" value={queuedCount} />
        <StatCard label="Processing" value={processingCount} />
        <StatCard label="Complete" value={completeCount} />
        <StatCard label="Failed" value={failedCount} highlight={failedCount > 0} />
      </div>

      <div className={styles.controls}>
        <div className={styles.filterChips}>
          {(Object.keys(FILTER_LABELS) as FilterKey[]).map(f => (
            <button
              key={f}
              className={styles.chip}
              data-active={filter === f}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search SKU…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th} onClick={() => handleSort('sku')}>
                SKU <SortIndicator col="sku" />
              </th>
              <th className={styles.th} onClick={() => handleSort('annotation')}>
                Annotation <SortIndicator col="annotation" />
              </th>
              <th className={styles.th} onClick={() => handleSort('processing')}>
                Processing <SortIndicator col="processing" />
              </th>
              <th className={`${styles.th} ${styles.thAction}`} />
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 && (
              <tr>
                <td className={styles.empty} colSpan={4}>
                  No items match this filter.
                </td>
              </tr>
            )}
            {sortedRows.map(row => (
              <tr key={row.sku} className={styles.tr} onClick={() => handleJump(row.index)}>
                <td className={styles.td}>
                  <span className={styles.skuText}>{row.sku}</span>
                </td>
                <td className={styles.td}>
                  <span className={styles.badge} data-status={row.annotationStatus}>
                    {ANNOTATION_LABELS[row.annotationStatus] ?? row.annotationStatus}
                  </span>
                </td>
                <td className={styles.td}>
                  {row.processingStatus != null ? (
                    <span className={styles.badge} data-pstatus={row.processingStatus}>
                      {PROCESSING_LABELS[row.processingStatus]}
                    </span>
                  ) : (
                    <span className={styles.dash}>—</span>
                  )}
                </td>
                <td className={styles.td}>
                  <button
                    className={styles.jumpBtn}
                    onClick={e => {
                      e.stopPropagation()
                      handleJump(row.index)
                    }}
                    tabIndex={-1}
                  >
                    →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div className={styles.statCard} data-highlight={highlight || undefined}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}
