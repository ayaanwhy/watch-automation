import { useEffect, useState } from 'react'
import styles from './AmbientBackground.module.css'

interface AmbientBackgroundProps {
  // True on precision screens (annotation, hoop boundary editor) — "freezes
  // entirely on annotation/hoop-editor screens (precision input never
  // competes with ambient GPU work)." App.tsx derives this from
  // view/editingBatch; this component has no navigation knowledge of its
  // own.
  freeze?: boolean
}

// App-level ambient layer (Phase 13C) — two slow-drifting ultraviolet
// radial gradients at low opacity plus a static noise/grain texture, per
// Visual Direction. Fixed, full-viewport, behind the shell; the shell
// content region stays opaque and occludes it almost entirely except at
// edges and through the glass sidebar. Pauses on window blur, freezes on
// precision screens, and collapses under prefers-reduced-motion (the
// data-reduced-motion attribute 13A's main.tsx sets) — all via CSS, no
// animation library.
export function AmbientBackground({ freeze = false }: AmbientBackgroundProps) {
  const [windowBlurred, setWindowBlurred] = useState(false)

  useEffect(() => {
    function handleBlur() {
      setWindowBlurred(true)
    }
    function handleFocus() {
      setWindowBlurred(false)
    }
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  const paused = freeze || windowBlurred

  return (
    <div className={styles.ambient} aria-hidden="true">
      <div className={`${styles.blob} ${styles.blobOne} ${paused ? styles.paused : ''}`} />
      <div className={`${styles.blob} ${styles.blobTwo} ${paused ? styles.paused : ''}`} />
      <div className={styles.grain} />
    </div>
  )
}
