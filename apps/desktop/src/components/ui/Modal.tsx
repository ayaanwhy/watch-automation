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

// Generalized (Phase 10F) from PreprocessingSettings.tsx's native-<dialog>
// pattern — that component is left as its own bespoke implementation since
// nothing in this phase requires touching it, but new dialogs build on this
// shared primitive instead of re-implementing the same ref/showModal/
// backdrop-click mechanics a third and fourth time. Native <dialog> gives
// Escape-to-close and focus trapping for free.
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
