import styles from './PathField.module.css'

interface PathFieldProps {
  label: string
  value: string
  placeholder: string
  onPick: () => void
  disabled?: boolean
  badge?: string
}

export function PathField({ label, value, placeholder, onPick, disabled = false, badge }: PathFieldProps) {
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label}>{label}</label>
        {badge && <span className={styles.badge}>{badge}</span>}
      </div>
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
