import { useEffect, useRef, useState } from 'react'
import { useQueue } from '../context/QueueContext'
import styles from './ProcessingQueue.module.css'

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  queued: 'Queued',
  processing: 'Processing…',
  complete: 'Done',
  failed: 'Failed',
}

export function ProcessingQueue() {
  const { items, retryItem } = useQueue()
  const [expanded, setExpanded] = useState(false)

  const total = items.length
  const failedCount = items.filter(i => i.status === 'failed').length
  const completeCount = items.filter(i => i.status === 'complete').length
  const processingCount = items.filter(i => i.status === 'processing').length
  const queuedCount = items.filter(i => i.status === 'queued' || i.status === 'pending').length

  // Auto-expand when the first item appears.
  const hasAutoExpandedRef = useRef(false)
  useEffect(() => {
    if (total > 0 && !hasAutoExpandedRef.current) {
      hasAutoExpandedRef.current = true
      setExpanded(true)
    }
  }, [total])

  // Auto-expand when a new failure occurs.
  useEffect(() => {
    if (failedCount > 0) setExpanded(true)
  }, [failedCount])

  if (total === 0) return null

  const summaryParts: string[] = []
  if (processingCount > 0) summaryParts.push(`${processingCount} processing`)
  if (queuedCount > 0) summaryParts.push(`${queuedCount} queued`)
  if (completeCount > 0) summaryParts.push(`${completeCount} done`)
  if (failedCount > 0) summaryParts.push(`${failedCount} failed`)
  const summary = summaryParts.join(' · ')

  return (
    <div className={styles.panel}>
      <button className={styles.header} onClick={() => setExpanded(e => !e)}>
        <span className={styles.title}>Processing Queue</span>
        <span className={styles.summary}>{summary}</span>
        <span className={styles.chevron}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className={styles.list}>
          {items.map(item => (
            <div key={item.id} className={styles.item}>
              <div className={styles.itemRow}>
                <span className={styles.itemSku}>{item.sku}</span>
                <div className={styles.itemRight}>
                  <span className={styles.itemBadge} data-status={item.status}>
                    {STATUS_LABELS[item.status] ?? item.status}
                  </span>
                  {item.status === 'failed' && (
                    <button className={styles.retryButton} onClick={() => retryItem(item.id)}>
                      Retry
                    </button>
                  )}
                </div>
              </div>
              {item.status === 'failed' && item.error && (
                <div className={styles.itemError}>{item.error}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
