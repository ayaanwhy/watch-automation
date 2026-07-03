import styles from './PathField.module.css'

interface PathFieldProps {
  label: string
  value: string
  placeholder: string
  onPick: () => void
  disabled?: boolean
}

export function PathField({ label, value, placeholder, onPick, disabled = false }: PathFieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <div className={styles.pathRow}>
        <span className={styles.pathDisplay}>
          {value !== '' ? value : <span className={styles.placeholder}>{placeholder}</span>}
        </span>
        <button className={styles.browseButton} onClick={onPick} disabled={disabled}>
          Browse
        </button>
      </div>
    </div>
  )
}
