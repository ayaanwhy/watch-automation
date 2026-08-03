import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import { useNativeDialog } from './useNativeDialog'
import styles from './FullscreenViewer.module.css'

interface FullscreenViewerProps {
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  hasPrev: boolean
  hasNext: boolean
  title?: string
  children: ReactNode
}

// Generic fullscreen review chrome (Phase 10F, lowest-priority item —
// implemented last). Deliberately content-agnostic: each caller renders its
// own existing preview panel (ImagePreviewPanel / RingBraceletImagePreviewPanel)
// as children at a larger size, so none of the before/after comparison
// rendering is duplicated here — this component only owns the backdrop,
// close button, and prev/next chrome (click + arrow keys). Prev/next are
// supplied by the caller, which already owns the ordered image list and
// current selection feeding its ThumbnailGrid — no new shared index state
// was needed to add this.
export function FullscreenViewer({ onClose, onPrev, onNext, hasPrev, hasNext, title, children }: FullscreenViewerProps) {
  const { dialogRef, handleClose, handleBackdropClick } = useNativeDialog(onClose)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' && hasPrev) onPrev()
      if (e.key === 'ArrowRight' && hasNext) onNext()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [hasPrev, hasNext, onPrev, onNext])

  return (
    <dialog ref={dialogRef} className={styles.dialog} onClose={onClose} onClick={handleBackdropClick}>
      <div className={styles.chrome}>
        <span className={styles.title}>{title}</span>
        <button className={styles.closeButton} onClick={handleClose} aria-label="Close fullscreen view">
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <button
        className={`${styles.navButton} ${styles.navPrev}`}
        onClick={onPrev}
        disabled={!hasPrev}
        aria-label="Previous image"
      >
        <ChevronLeft size={22} strokeWidth={1.5} aria-hidden="true" />
      </button>

      <div className={styles.content}>{children}</div>

      <button
        className={`${styles.navButton} ${styles.navNext}`}
        onClick={onNext}
        disabled={!hasNext}
        aria-label="Next image"
      >
        <ChevronRight size={22} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </dialog>
  )
}
