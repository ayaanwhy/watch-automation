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
}

const ROTATE_OPTIONS: { value: EditingHandoffRotate; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'cw', label: 'Clockwise' },
  { value: 'ccw', label: 'Anti-clockwise' },
  { value: '180', label: '180°' },
]

// Watch, Ring and Bracelet are all fully wired destinations (Phase 10F) —
// none are disabled placeholders. Earrings isn't offered here at all yet
// (no Editing workflow exists for it), consistent with keeping this one
// dialog rather than a second version per destination.
const DESTINATION_OPTIONS: { value: EditingProduct; label: string }[] = [
  { value: 'watch', label: 'Watch' },
  { value: 'ring', label: 'Ring' },
  { value: 'bracelet', label: 'Bracelet' },
]

// Generic Preprocessing → Editing hand-off dialog (Phase 10F) — generalized
// from the original Watch-only one-click "Continue to Watch Processing"
// action. Remembers the operator's last-used Trim/Rotate/Destination choices
// across runs (prefs, same pattern as SAM tuning) so a repeat hand-off to
// the same destination doesn't require re-selecting every option.
export function EditingHandoffDialog({ onConfirm, onClose }: EditingHandoffDialogProps) {
  const [trim, setTrim] = useState(true)
  const [rotate, setRotate] = useState<EditingHandoffRotate>('ccw')
  const [destination, setDestination] = useState<EditingProduct>('watch')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void window.api.invoke('prefs:load-editing-handoff-options').then(prefs => {
      if (prefs) {
        setTrim(prefs.trim)
        setRotate(prefs.rotate)
        setDestination(prefs.destination)
      }
      setLoaded(true)
    })
  }, [])

  function handleConfirm() {
    const options: EditingHandoffOptions = { trim, rotate, destination }
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
          <input type="checkbox" checked={trim} onChange={e => setTrim(e.target.checked)} />
          Trim Image
        </label>

        <SegmentedControl label="Rotate" options={ROTATE_OPTIONS} value={rotate} onChange={setRotate} />

        <SegmentedControl label="Destination" options={DESTINATION_OPTIONS} value={destination} onChange={setDestination} />
      </div>
    </Modal>
  )
}
