import { useCallback, useEffect, useState } from 'react'
import { factoryShadowProfileDefinitions } from '../constants/shadowProfiles'
import type {
  ShadowProfileName,
  ShadowProfileDefinitions,
  ShadowProfileValues,
} from '../constants/shadowProfiles'

// Mirrors usePreprocessingPresetDefinitions.ts exactly — same hydrate-once/
// commit-on-save shape, same reason (Settings is the only editor; other
// screens never need this).
export function useShadowProfileDefinitions() {
  const [definitions, setDefinitions] = useState<ShadowProfileDefinitions>(factoryShadowProfileDefinitions())
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.invoke('prefs:load-shadow-profile-definitions').then(loaded => {
      setDefinitions(loaded)
      setLoaded(true)
    })
  }, [])

  // Saving increments that profile's version on the main process (the
  // authoritative counter — see shadowProfileDefinitions.ts); the returned
  // definition (with its new version) replaces local state so the two never
  // drift.
  const saveValues = useCallback(async (name: ShadowProfileName, values: ShadowProfileValues) => {
    const updated = await window.api.invoke('prefs:save-shadow-profile-definition', { name, values })
    setDefinitions(prev => ({ ...prev, [name]: updated }))
  }, [])

  return { definitions, loaded, saveValues }
}
