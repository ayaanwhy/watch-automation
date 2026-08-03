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

// Editing what each preset name actually means is still Settings-only
// (saveValues/resetToDefault). Preprocessing.tsx (Phase 13E) also reads
// `definitions` now, but read-only — to compute each preset card's
// "Customized" marker via isPresetModified — it still only ever sends a
// preset name at start time (see usePreprocessingPreset.ts).
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
