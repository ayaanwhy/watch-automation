import { useCallback, useEffect, useState } from 'react'
import type { AppearancePrefs } from '../types/ipc'

const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  reducedMotion: 'system',
  reducedTransparency: 'system',
  ambientIntensity: 'standard',
}

// Settings' Appearance section (Phase 13H) reads/writes this; the always-
// mounted AppearanceEffects component (App.tsx) reads it too, independently,
// so the effect applies even when Settings isn't open — same reason
// JobCompletionToasts is mounted at the app root rather than inside any one
// screen.
export function useAppearancePrefs() {
  const [prefs, setPrefs] = useState<AppearancePrefs>(DEFAULT_APPEARANCE_PREFS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.invoke('prefs:load-appearance').then(loaded => {
      setPrefs(loaded)
      setLoaded(true)
    })
  }, [])

  const savePrefs = useCallback((next: AppearancePrefs) => {
    setPrefs(next)
    void window.api.invoke('prefs:save-appearance', next)
  }, [])

  return { prefs, loaded, savePrefs }
}
