import type { ReactNode } from 'react'
import { X } from 'lucide-react'
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
// free. Phase 13B: rebuilt as one of the four sanctioned glass surfaces
// (Decision 5) — blurred surface-3 basis, hairline border, top-edge
// highlight, scale-from-0.97 + fade entrance (220ms) via @starting-style
// (no animation library; Electron's bundled Chromium supports it).
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
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.body}>{children}</div>

      {footer && <div className={styles.footer}>{footer}</div>}
    </dialog>
  )
}
