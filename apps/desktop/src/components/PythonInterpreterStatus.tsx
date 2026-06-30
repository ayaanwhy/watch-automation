import styles from './PythonInterpreterStatus.module.css'

interface PythonInterpreterStatusProps {
  resolvedPath: string | null
  resolving: boolean
  override: string
  onOverrideChange: (value: string) => void
}

export function PythonInterpreterStatus({
  resolvedPath,
  resolving,
  override,
  onOverrideChange,
}: PythonInterpreterStatusProps) {
  const usingOverride = override.trim() !== ''

  return (
    <div className={styles.field}>
      <label className={styles.label}>Python Interpreter</label>

      <div className={styles.statusRow}>
        {resolving ? (
          <span className={styles.detecting}>Detecting…</span>
        ) : usingOverride ? (
          <span className={styles.ok}>Using manual override</span>
        ) : resolvedPath ? (
          <span className={styles.ok}>✓ Python environment detected</span>
        ) : (
          <span className={styles.warn}>⚠ Python not found</span>
        )}
      </div>

      {!resolving && resolvedPath && !usingOverride && (
        <div className={styles.detectedPath}>{resolvedPath}</div>
      )}

      <input
        className={styles.overrideInput}
        type="text"
        value={override}
        onChange={(e) => onOverrideChange(e.target.value)}
        placeholder="Override interpreter path (optional)"
        spellCheck={false}
      />
    </div>
  )
}
