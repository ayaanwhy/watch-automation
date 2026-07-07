import { useState } from 'react'
import type { BatchSummaryRecord } from '../../types/batch'
import { Card } from '../ui/Card'
import { StatusChip } from '../ui/StatusChip'
import { Button } from '../ui/Button'
import {
  BATCH_STATUS_LABELS,
  STAGE_LABELS,
  batchStatusTone,
  formatDuration,
  formatRelativeTime,
  stageStatusTone,
} from './batchDisplay'
import styles from './BatchCard.module.css'

interface BatchCardProps {
  batch: BatchSummaryRecord
  onRenamed: (updated: BatchSummaryRecord) => void
}

// Glance-complete execution-history card: status, title, pipeline (with each
// stage's status), image counts, duration, and timestamp — so users rarely
// need to open a batch just to understand what happened.
//
// Non-navigational: reopening a batch into a live view is the Phase 9E Batch
// Details screen. For now the only action a card supports is renaming — the
// auto-generated title remains the default but is never permanent.
export function BatchCard({ batch, onRenamed }: BatchCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(batch.title)
  const [saving, setSaving] = useState(false)

  const { counts } = batch
  const hasCounts = counts.total > 0

  async function handleSave() {
    const title = draft.trim()
    if (!title || title === batch.title) {
      setDraft(batch.title)
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      const updated = await window.api.invoke('batch-registry:rename', { id: batch.id, title })
      if (updated) onRenamed(updated)
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  function handleCancel() {
    setDraft(batch.title)
    setEditing(false)
  }

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        {editing ? (
          <div className={styles.editRow}>
            <input
              className={styles.editInput}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void handleSave()
                if (e.key === 'Escape') handleCancel()
              }}
              disabled={saving}
              autoFocus
              spellCheck={false}
            />
            <Button size="sm" variant="ghost" onClick={handleSave} disabled={saving}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <span className={styles.titleGroup}>
              <span className={styles.title}>{batch.title}</span>
              <button
                className={styles.editButton}
                onClick={() => setEditing(true)}
                aria-label="Rename batch"
                title="Rename"
              >
                ✎
              </button>
            </span>
            <StatusChip tone={batchStatusTone(batch.status)}>
              {BATCH_STATUS_LABELS[batch.status]}
            </StatusChip>
          </>
        )}
      </div>

      <div className={styles.pipeline}>
        {batch.stageStatuses.map(s => (
          <span key={s.type} className={styles.stage}>
            <span className={`${styles.dot} ${styles[stageStatusTone(s.status)]}`} aria-hidden="true" />
            {STAGE_LABELS[s.type]}
          </span>
        ))}
      </div>

      <div className={styles.meta}>
        <span>
          {hasCounts
            ? `${counts.succeeded}✓${counts.failed > 0 ? ` · ${counts.failed}✗` : ''} / ${counts.total}`
            : 'No images yet'}
        </span>
        <span className={styles.metaRight}>
          <span>{formatDuration(batch.durationMs)}</span>
          <span className={styles.time}>{formatRelativeTime(batch.createdAt)}</span>
        </span>
      </div>
    </Card>
  )
}
