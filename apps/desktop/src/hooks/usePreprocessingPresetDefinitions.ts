import { useCallback, useEffect, useState } from 'react'
import {
  factoryPresetDefinitions,
  resolveFactoryPreset,
} from '../constants/preprocessingPresets'
import type {
  PreprocessingPreset,
  PreprocessingPresetDefinitions,
  PreprocessingPresetValues,
} from '../constants/preprocessingPresets'

// Settings-only — Preprocessing.tsx never uses this; it only sends a preset
// name (see usePreprocessingPreset.ts). This hook owns editing what each
// name actually means.
export function usePreprocessingPresetDefinitions() {
  const [definitions, setDefinitions] = useState<PreprocessingPresetDefinitions>(factoryPresetDefinitions())
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api.invoke('prefs:load-preprocessing-preset-definitions').then(loaded => {
      setDefinitions(loaded)
      setLoaded(true)
    })
  }, [])

  // Saving increments the preset's version on the main process (the
  // authoritative counter — see preprocessingPresetDefinitions.ts); the
  // returned definition (with its new version) replaces local state so the
  // two never drift.
  const saveValues = useCallback(async (preset: PreprocessingPreset, values: PreprocessingPresetValues) => {
    const updated = await window.api.invoke('prefs:save-preprocessing-preset-definition', { preset, values })
    setDefinitions(prev => ({ ...prev, [preset]: updated }))
  }, [])

  const resetToDefault = useCallback((preset: PreprocessingPreset) => {
    void saveValues(preset, resolveFactoryPreset(preset))
  }, [saveValues])

  return { definitions, loaded, saveValues, resetToDefault }
}
