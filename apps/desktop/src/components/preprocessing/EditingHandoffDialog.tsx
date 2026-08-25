import { useEffect, useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { SegmentedControl } from '../ui/SegmentedControl'
import type { EditingHandoffRotate } from '../../types/ipc'
import type { EditingProduct } from '../../types/navigation'
import styles from './EditingHandoffDialog.module.css'

export interface EditingHandoffOptions {
  trim: boolean
  rotate: EditingHandoffRotate
  destination: EditingProduct
}

interface EditingHandoffDialogProps {
  onConfirm: (options: EditingHandoffOptions) => void
  onClose: () => void
  // The product this batch is already known to be (its Preprocessing
  // "Target"), when determinable — wins over the operator's last-used
  // destination pref, since preselecting the correct product for THIS
  // batch is more useful than repeating whatever was picked last time.
  // Undefined when the source batch's target is generic/unrecognized, in
  // which case prior behavior (last-used pref, else Watch) applies.
  suggestedDestination?: EditingProduct
}

const ROTATE_OPTIONS: { value: EditingHandoffRotate; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'cw', label: 'Clockwise' },
  { value: 'ccw', label: 'Anti-clockwise' },
  { value: '180', label: '180°' },
]

// Watch, Ring, Bracelet, and (Phase 12C) Earring are all fully wired
// destinations — none are disabled placeholders.
const DESTINATION_OPTIONS: { value: EditingProduct; label: string }[] = [
  { value: 'watch', label: 'Watch' },
  { value: 'ring', label: 'Ring' },
  { value: 'bracelet', label: 'Bracelet' },
  { value: 'earring', label: 'Earring' },
]

// Generic Preprocessing → Editing hand-off dialog (Phase 10F) — generalized
// from the original Watch-only one-click "Continue to Watch Processing"
// action. Remembers the operator's last-used Trim/Rotate/Destination choices
// across runs (prefs, same pattern as SAM tuning) so a repeat hand-off to
// the same destination doesn't require re-selecting every option.
export function EditingHandoffDialog({ onConfirm, onClose, suggestedDestination }: EditingHandoffDialogProps) {
  const [trim, setTrim] = useState(true)
  const [rotate, setRotate] = useState<EditingHandoffRotate>('ccw')
  const [destination, setDestination] = useState<EditingProduct>(suggestedDestination ?? 'watch')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void window.api.invoke('prefs:load-editing-handoff-options').then(prefs => {
      if (prefs) {
        setTrim(prefs.trim)
        setRotate(prefs.rotate)
        setDestination(suggestedDestination ?? prefs.destination)
      }
      setLoaded(true)
    })
  }, [suggestedDestination])

  // Earring's shadow profiles are authored against a fixed 1000px canvas
  // basis (Phase 12A/12C) that assumes a trimmed, unrotated subject — so
  // Trim/Rotate aren't left to the operator's last-used values here the way
  // they are for every other destination.
  const isEarring = destination === 'earring'
  const effectiveTrim = isEarring ? true : trim
  const effectiveRotate = isEarring ? 'none' : rotate

  function handleConfirm() {
    const options: EditingHandoffOptions = { trim: effectiveTrim, rotate: effectiveRotate, destination }
    void window.api.invoke('prefs:save-editing-handoff-options', options)
    onConfirm(options)
  }

  return (
    <Modal
      title="Continue to Editing"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!loaded}>Continue</Button>
        </>
      }
    >
      <div className={styles.body}>
        <label className={styles.checkboxRow}>
          <input type="checkbox" checked={effectiveTrim} disabled={isEarring} onChange={e => setTrim(e.target.checked)} />
          Trim Image
        </label>

        <SegmentedControl label="Rotate" options={ROTATE_OPTIONS} value={effectiveRotate} onChange={setRotate} disabled={isEarring} />

        {isEarring && (
          <p className={styles.earringNote}>
            Earring requires a trimmed, unrotated image — Trim and Rotate are fixed for this destination.
          </p>
        )}

        <SegmentedControl label="Destination" options={DESTINATION_OPTIONS} value={destination} onChange={setDestination} />
      </div>
    </Modal>
  )
}
