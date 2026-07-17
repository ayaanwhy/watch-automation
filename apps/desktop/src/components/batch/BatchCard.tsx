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
  stageModuleTone,
  stageStatusTone,
} from './batchDisplay'
import styles from './BatchCard.module.css'

const MODULE_BADGE_CLASS: Record<'blue' | 'purple' | 'neutral', string> = {
  blue: styles.moduleBlue,
  purple: styles.modulePurple,
  neutral: styles.moduleNeutral,
}

interface BatchCardProps {
  batch: BatchSummaryRecord
  onOpen: () => void
  onRenamed: (updated: BatchSummaryRecord) => void
  onDeleted: (id: string) => void
}

// Glance-complete execution-history card: status, title, pipeline (with each
// stage's status), image counts, duration, and timestamp — so users rarely
// need to open a batch just to understand what happened. Clicking the card
// opens it into Batch Details (Phase 9E) or its live stage; the ✎ affordance
// still renames in place without opening it — the auto-generated title
// remains the default but is never permanent.
export function BatchCard({ batch, onOpen, onRenamed, onDeleted }: BatchCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(batch.title)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

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

  async function handleDelete() {
    // Never touches generated outputs or user assets — only this batch's
    // own registry bookkeeping (index entry + detail file).
    if (!window.confirm(`Delete "${batch.title}"? This only removes it from history — no files are deleted.`)) {
      return
    }
    setDeleting(true)
    try {
      await window.api.invoke('batch-registry:delete', { id: batch.id })
      onDeleted(batch.id)
    } finally {
      setDeleting(false)
    }
  }

  // Card itself stays a plain container (not a <button>) so the ✎ button can
  // be a real, independently-clickable descendant without nesting one button
  // inside another. The click zone below opens the card; onClick is only
  // active while not editing, so clicking into the rename input never
  // triggers it, and the ✎ button stops propagation as its one exception.
  return (
    <Card className={styles.card}>
      <div
        className={editing ? styles.clickAreaEditing : styles.clickArea}
        onClick={editing ? undefined : onOpen}
        role={editing ? undefined : 'button'}
        tabIndex={editing ? undefined : 0}
        onKeyDown={
          editing
            ? undefined
            : e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpen()
                }
              }
        }
      >
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
                  onClick={e => {
                    e.stopPropagation()
                    setEditing(true)
                  }}
                  aria-label="Rename batch"
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  className={styles.editButton}
                  onClick={e => {
                    e.stopPropagation()
                    void handleDelete()
                  }}
                  disabled={deleting}
                  aria-label="Delete batch"
                  title="Delete"
                >
                  🗑
                </button>
              </span>
              <span className={styles.chips}>
                {batch.mode === 'testing' && <StatusChip tone="warn">Testing</StatusChip>}
                <StatusChip tone={batchStatusTone(batch.status)}>
                  {BATCH_STATUS_LABELS[batch.status]}
                </StatusChip>
              </span>
            </>
          )}
        </div>

        <div className={styles.pipeline}>
          {batch.stageStatuses.map(s => (
            <span
              key={s.type}
              className={`${styles.stage} ${MODULE_BADGE_CLASS[stageModuleTone(s.type)]}`}
            >
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
      </div>
    </Card>
  )
}
