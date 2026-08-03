import { useState, type DragEvent } from 'react'
import { FolderOpen } from 'lucide-react'
import styles from './PathField.module.css'

interface PathFieldProps {
  label: string
  value: string
  placeholder: string
  onPick: () => void
  // Phase 9E.1: a path dropped onto this field is resolved exactly the same
  // way a picked one is — the caller applies it via the same setter/validation
  // path as onPick, just with an explicit value instead of opening a dialog.
  onDropPath?: (path: string) => void
  disabled?: boolean
  badge?: string
}

export function PathField({ label, value, placeholder, onPick, onDropPath, disabled = false, badge }: PathFieldProps) {
  const [dragOver, setDragOver] = useState(false)

  const dropEnabled = !disabled && onDropPath !== undefined

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (!dropEnabled) return
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave() {
    setDragOver(false)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    if (!dropEnabled) return
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    // Electron exposes the real filesystem path on dropped File objects
    // (not part of the standard web File API elsewhere).
    const path = file ? (file as unknown as { path?: string }).path : undefined
    if (path) onDropPath!(path)
  }

  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label}>{label}</label>
        {badge && <span className={styles.badge}>{badge}</span>}
      </div>
      <div
        className={`${styles.pathRow} ${dragOver ? styles.pathRowDragOver : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className={styles.pathDisplay}>
          {value !== '' ? value : <span className={styles.placeholder}>{placeholder}</span>}
        </span>
        <button className={styles.browseButton} onClick={onPick} disabled={disabled}>
          <FolderOpen size={14} strokeWidth={1.5} aria-hidden="true" />
          Browse
        </button>
      </div>
    </div>
  )
}
