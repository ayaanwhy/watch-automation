import { useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import type { SandboxEditor } from '../types/sandboxDisposition'
import { validateSandboxRejectionInput } from '../lib/sandboxReviewData'
import styles from './SandboxRejectionDialog.module.css'

interface SandboxRejectionDialogProps {
  itemCount: number
  editors: SandboxEditor[]
  defaultEditorId: string | null
  onConfirm: (input: { reason: string; instructions: string | null; editor: SandboxEditor }) => void
  onClose: () => void
  submitting: boolean
}

// Focused rejection dialog (Phase 15.6, section 8) — reason required,
// instructions optional, editor required and must come from the
// Sandbox-supplied editor list (never a free-text/invented name). Works
// identically for one item or a bulk selection (section 9) — the caller
// just supplies itemCount for the confirmation copy; the same reason/
// instructions/editor apply to every selected item.
export function SandboxRejectionDialog({
  itemCount,
  editors,
  defaultEditorId,
  onConfirm,
  onClose,
  submitting,
}: SandboxRejectionDialogProps) {
  const [reason, setReason] = useState('')
  const [instructions, setInstructions] = useState('')
  const [editorId, setEditorId] = useState<string>(defaultEditorId ?? editors[0]?.id ?? '')

  useEffect(() => {
    if (!editorId && editors[0]) setEditorId(editors[0].id)
  }, [editors, editorId])

  const selectedEditor = editors.find(e => e.id === editorId) ?? null
  const validation = validateSandboxRejectionInput({ reason, instructions, editor: selectedEditor })

  function handleConfirm() {
    if (!validation.ok || !selectedEditor) return
    onConfirm({ reason: reason.trim(), instructions: instructions.trim() || null, editor: selectedEditor })
  }

  return (
    <Modal
      title={itemCount === 1 ? 'Reject Item' : `Reject ${itemCount} Items`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={!validation.ok || submitting} loading={submitting}>
            Confirm Rejection
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="sandbox-rejection-reason">
            Reason <span className={styles.required}>(required)</span>
          </label>
          <textarea
            id="sandbox-rejection-reason"
            className={styles.textarea}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Why is this being rejected?"
            rows={3}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="sandbox-rejection-instructions">
            Instructions <span className={styles.optional}>(optional)</span>
          </label>
          <textarea
            id="sandbox-rejection-instructions"
            className={styles.textarea}
            value={instructions}
            onChange={e => setInstructions(e.target.value)}
            placeholder="Anything the editor should know"
            rows={2}
          />
        </div>

        <Select
          label="Assigned Editor"
          options={editors.map(e => ({ value: e.id, label: e.name }))}
          value={editorId}
          onChange={setEditorId}
          disabled={editors.length === 0}
        />
        {editors.length === 0 && <p className={styles.note}>No editors available from the Sandbox API.</p>}
      </div>
    </Modal>
  )
}
