import { Modal } from './Modal'
import { Button } from './Button'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  // 'danger' renders the confirm action as Button's danger variant — for
  // destructive confirms (delete, discard). Default is a plain primary
  // action.
  tone?: 'default' | 'danger'
  onConfirm: () => void
  onCancel: () => void
}

// The "standard destructive-confirm variant" the Component System's Dialog
// entry calls for, retiring window.confirm. A thin Modal wrapper — see
// useConfirmDialog for the ergonomic promise-based way callers actually use
// this (App.tsx, BatchCard.tsx).
export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default', onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={400}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  )
}
