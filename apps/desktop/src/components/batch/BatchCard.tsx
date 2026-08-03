import { useState } from 'react'
import { Pencil, Trash2, Check, X, Layers, Gem } from 'lucide-react'
import type { BatchSummaryRecord } from '../../types/batch'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { ProgressRing } from '../ui/ProgressRing'
import { WatchGlyph, type IconComponent } from '../icons/ProductGlyphs'
import { useConfirmDialog } from '../ui/useConfirmDialog'
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
  onOpen: () => void
  onRenamed: (updated: BatchSummaryRecord) => void
  onDeleted: (id: string) => void
  // Completion moment (Phase 13D, Decision — Dashboard) — set true for
  // exactly one render by the parent when this batch's job transitions
  // running → done while the Dashboard is mounted; this component owns the
  // one-shot CSS animation itself, not the parent.
  justCompleted?: boolean
}

// BatchSummaryRecord carries `pipeline` (stage types) but not a specific
// editing product — that lives in a stage's `config`, only present in the
// full BatchDetailRecord (Phase 13D limitation: fetching per-card detail
// would defeat the point of a lightweight list, and product wasn't the one
// approved additive summary field this phase — see the Phase 13D report).
// Watch and pure-Preprocessing pipelines are unambiguous from `pipeline`
// alone; an Editing pipeline falls back to a generic gem glyph rather than
// guessing Ring/Bracelet/Earring.
function batchGlyph(batch: BatchSummaryRecord): IconComponent {
  if (batch.pipeline.includes('watch')) return WatchGlyph
  if (batch.pipeline.includes('editing')) return Gem
  return Layers
}

// Glance-complete execution-history card: status, title, pipeline (with each
// stage's status), image counts, duration, and timestamp — so users rarely
// need to open a batch just to understand what happened. Clicking the card
// opens it into Batch Details (Phase 9E) or its live stage; the rename
// affordance still renames in place without opening it.
//
// Phase 13D — rebuilt on tokens: Badge (retires StatusChip) for every status
// pill including the per-stage pipeline row (module-color chips retired —
// violet restraint rules keep filters/chips graphite, and the product glyph
// now carries identity instead), lucide icons replace ✎/🗑, a ProgressRing
// shows live progress while running, hover lift per Component System.
export function BatchCard({ batch, onOpen, onRenamed, onDeleted, justCompleted }: BatchCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(batch.title)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Retires window.confirm (Phase 13B) — see useConfirmDialog's own doc
  // comment.
  const { confirm, dialog: confirmDialog } = useConfirmDialog()

  const { counts } = batch
  const hasCounts = counts.total > 0
  const isRunning = batch.status === 'in_progress'
  const progressed = counts.succeeded + counts.failed + counts.cancelled + counts.needsFixing
  const percent = hasCounts ? (progressed / counts.total) * 100 : undefined
  const Glyph = batchGlyph(batch)

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
    const ok = await confirm(`Delete "${batch.title}"? This only removes it from history — no files are deleted.`, {
      title: 'Delete batch',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) {
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

  // Card itself stays a plain container (not a <button>) so the icon
  // buttons can be real, independently-clickable descendants without
  // nesting one button inside another. The click zone below opens the
  // card; onClick is only active while not editing, so clicking into the
  // rename input never triggers it, and the icon buttons stop propagation
  // as their one exception.
  return (
    <Card className={`${styles.card} ${justCompleted ? styles.completionPulse : ''}`}>
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
          <span className={styles.glyphSlot}>
            {isRunning ? (
              <ProgressRing value={percent} size={22} strokeWidth={2} className={styles.ring} />
            ) : (
              <Glyph size={18} strokeWidth={1.5} className={styles.glyph} />
            )}
          </span>

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
                  className={styles.iconButton}
                  onClick={e => {
                    e.stopPropagation()
                    setEditing(true)
                  }}
                  aria-label="Rename batch"
                  title="Rename"
                >
                  <Pencil size={13} strokeWidth={1.5} aria-hidden="true" />
                </button>
                <button
                  className={styles.iconButton}
                  onClick={e => {
                    e.stopPropagation()
                    void handleDelete()
                  }}
                  disabled={deleting}
                  aria-label="Delete batch"
                  title="Delete"
                >
                  <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </span>
              <span className={styles.chips}>
                {batch.mode === 'testing' && <Badge tone="warning">Testing</Badge>}
                <Badge tone={batchStatusTone(batch.status)}>{BATCH_STATUS_LABELS[batch.status]}</Badge>
              </span>
            </>
          )}
        </div>

        <div className={styles.pipeline}>
          {batch.stageStatuses.map(s => (
            <Badge key={s.type} tone={stageStatusTone(s.status)}>
              {STAGE_LABELS[s.type]}
            </Badge>
          ))}
        </div>

        <div className={`${styles.meta} tabular-nums`}>
          <span className={styles.metaLeft}>
            {hasCounts ? (
              <>
                <span className={styles.metaCount}>
                  <Check size={12} strokeWidth={2} className={styles.metaOk} aria-hidden="true" />
                  {counts.succeeded}
                </span>
                {counts.failed > 0 && (
                  <span className={styles.metaCount}>
                    <X size={12} strokeWidth={2} className={styles.metaErr} aria-hidden="true" />
                    {counts.failed}
                  </span>
                )}
                <span className={styles.metaTotal}>/ {counts.total}</span>
              </>
            ) : (
              'No images yet'
            )}
          </span>
          <span className={styles.metaRight}>
            <span>{formatDuration(batch.durationMs)}</span>
            <span className={styles.time}>{formatRelativeTime(batch.createdAt)}</span>
          </span>
        </div>
      </div>
      {confirmDialog}
    </Card>
  )
}
