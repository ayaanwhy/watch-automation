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

  const failedCount = items.filter(i => i.status === 'failed').length
  const completeCount = items.filter(i => i.status === 'complete').length
  const processingCount = items.filter(i => i.status === 'processing').length
  const queuedCount = items.filter(i => i.status === 'queued' || i.status === 'pending').length

  const summaryParts: string[] = []
  if (processingCount > 0) summaryParts.push(`${processingCount} processing`)
  if (queuedCount > 0) summaryParts.push(`${queuedCount} queued`)
  if (completeCount > 0) summaryParts.push(`${completeCount} done`)
  if (failedCount > 0) summaryParts.push(`${failedCount} failed`)
  const summary = summaryParts.join(' · ')

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Queue</span>
        {summary && <span className={styles.summary}>{summary}</span>}
      </div>

      <div className={styles.list}>
        {items.length === 0 && (
          <div className={styles.empty}>No items yet.</div>
        )}
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
    </div>
  )
}
