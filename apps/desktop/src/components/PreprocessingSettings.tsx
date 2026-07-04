import { useEffect, useRef } from 'react'
import { SamTuningPanel } from './SamTuningPanel'
import type { SamTuningPrefs } from '../types/ipc'
import styles from './PreprocessingSettings.module.css'

interface PreprocessingSettingsProps {
  sam: {
    prefs: SamTuningPrefs
    update: <K extends keyof SamTuningPrefs>(key: K, value: SamTuningPrefs[K]) => void
  }
  disabled: boolean
  onClose: () => void
}

// Settings modal for the Preprocessing screen.
// Uses the native <dialog> element so Escape and focus-trap are handled
// by the browser without custom logic.
// Future settings sections (Detection Quality, etc.) are added inside .body.
export function PreprocessingSettings({ sam, disabled, onClose }: PreprocessingSettingsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  function handleClose() {
    dialogRef.current?.close()
    onClose()
  }

  // Close when clicking the backdrop (the dialog element itself, not its content)
  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) handleClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      onClose={onClose}
      onClick={handleBackdropClick}
    >
      <div className={styles.header}>
        <span className={styles.title}>Settings</span>
        <button className={styles.closeButton} onClick={handleClose} aria-label="Close settings">
          ✕
        </button>
      </div>

      <div className={styles.body}>
        <SamTuningPanel prefs={sam.prefs} onUpdate={sam.update} disabled={disabled} />
      </div>
    </dialog>
  )
}
