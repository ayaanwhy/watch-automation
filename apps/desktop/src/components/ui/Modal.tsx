import type { ReactNode } from 'react'
import { useNativeDialog } from './useNativeDialog'
import styles from './Modal.module.css'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}

// Shared native-<dialog> modal primitive (Phase 10F) — new dialogs build on
// this instead of re-implementing the same ref/showModal/backdrop-click
// mechanics. Native <dialog> gives Escape-to-close and focus trapping for
// free.
export function Modal({ title, onClose, children, footer, width = 460 }: ModalProps) {
  const { dialogRef, handleClose, handleBackdropClick } = useNativeDialog(onClose)

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      style={{ width }}
      onClose={onClose}
      onClick={handleBackdropClick}
    >
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button className={styles.closeButton} onClick={handleClose} aria-label={`Close ${title}`}>
          ✕
        </button>
      </div>

      <div className={styles.body}>{children}</div>

      {footer && <div className={styles.footer}>{footer}</div>}
    </dialog>
  )
}
