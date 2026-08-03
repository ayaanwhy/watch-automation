import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Button } from '../ui/Button'
import type { EditingHandoffRotate, PrepareProgressPayload } from '../../types/ipc'
import styles from './PrepareInputDisclosure.module.css'

const ROTATE_OPTIONS: { value: EditingHandoffRotate; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'cw', label: 'Clockwise' },
  { value: 'ccw', label: 'Anti-clockwise' },
  { value: '180', label: '180°' },
]

interface PrepareInputDisclosureProps {
  sourceDir: string
  // Earring's shadow profiles are authored against a fixed 1000px canvas
  // basis (Phase 12A) that assumes a trimmed, unrotated subject — the exact
  // same constraint EditingHandoffDialog.tsx already enforces for the
  // Preprocessing→Editing hand-off; mirrored here since this disclosure
  // reaches the same preprocess:prepare-for-editing-handoff IPC directly.
  isEarring: boolean
  disabled?: boolean
  onPrepared: (preparedDir: string, imageCount: number) => void
}

// "Prepare input" disclosure (Phase 13E, Decision 16) — collapsed by default
// ("Use images as-is"), expanding to Trim/Rotate/Resize. Calls the existing
// preprocess:prepare-for-editing-handoff IPC directly on whatever input
// folder is currently selected — the same channel EditingHandoffDialog.tsx
// uses for the Preprocessing→Editing hand-off, just triggered from inside
// the Editing console instead of a modal launched from Batch Details.
// Folder-in/folder-out; no runner or Python contract changes.
export function PrepareInputDisclosure({ sourceDir, isEarring, disabled, onPrepared }: PrepareInputDisclosureProps) {
  const [expanded, setExpanded] = useState(false)
  const [trim, setTrim] = useState(true)
  const [rotate, setRotate] = useState<EditingHandoffRotate>('none')
  const [preparing, setPreparing] = useState(false)
  const [progress, setProgress] = useState<PrepareProgressPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveTrim = isEarring ? true : trim
  const effectiveRotate: EditingHandoffRotate = isEarring ? 'none' : rotate

  useEffect(() => {
    if (!preparing) return
    const off = window.api.on('preprocess:prepare-progress', (payload: PrepareProgressPayload) => {
      setProgress(payload)
    })
    return off
  }, [preparing])

  async function handlePrepare() {
    if (sourceDir === '' || disabled) return
    setPreparing(true)
    setProgress(null)
    setError(null)
    const result = await window.api.invoke('preprocess:prepare-for-editing-handoff', {
      sourceDir,
      trim: effectiveTrim,
      rotate: effectiveRotate,
      ...(isEarring ? { resizeToHeight: 1000 } : {}),
    })
    setPreparing(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onPrepared(result.preparedDir, result.imageCount)
  }

  return (
    <div className={styles.disclosure}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setExpanded(e => !e)}
        disabled={disabled}
        aria-expanded={expanded}
      >
        <ChevronRight size={14} strokeWidth={1.5} className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} aria-hidden="true" />
        Prepare input
        {!expanded && <span className={styles.toggleHint}>— Use images as-is</span>}
      </button>

      {expanded && (
        <div className={styles.body}>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={effectiveTrim}
              disabled={isEarring || disabled}
              onChange={e => setTrim(e.target.checked)}
            />
            Trim Image
          </label>

          <SegmentedControl
            label="Rotate"
            options={ROTATE_OPTIONS}
            value={effectiveRotate}
            onChange={setRotate}
            disabled={isEarring || disabled}
          />

          {isEarring && (
            <p className={styles.note}>
              Earring requires a trimmed, unrotated image resized to 1000px — these are fixed for this destination.
            </p>
          )}
          {!isEarring && (
            <p className={styles.note}>No resize step for this destination — only Trim and Rotate apply.</p>
          )}

          {error && <div className={styles.errorBanner}>{error}</div>}

          <Button
            variant="secondary"
            size="sm"
            onClick={handlePrepare}
            loading={preparing}
            disabled={disabled || sourceDir === ''}
          >
            {preparing && progress ? `Preparing… (${progress.completed}/${progress.total})` : 'Prepare'}
          </Button>
        </div>
      )}
    </div>
  )
}
