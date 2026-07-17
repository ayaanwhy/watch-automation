import { useEffect, useRef, type MouseEvent } from 'react'

// Shared native-<dialog> mechanics (Phase 10F) — ref + showModal-on-mount +
// backdrop-click-to-close. Factored out of Modal.tsx once FullscreenViewer
// needed the exact same mechanic a second time; gives Escape-to-close and
// focus trapping for free via the native element. PreprocessingSettings.tsx
// predates this and keeps its own independent copy of the same pattern —
// migrating it wasn't required by anything in this phase, so it was left as
// its own bespoke implementation rather than touched.
export function useNativeDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  function handleClose() {
    dialogRef.current?.close()
    onClose()
  }

  function handleBackdropClick(e: MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) handleClose()
  }

  return { dialogRef, handleClose, handleBackdropClick }
}
