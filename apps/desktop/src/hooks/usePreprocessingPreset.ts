import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_PREPROCESSING_PRESET, type PreprocessingPreset } from '../constants/preprocessingPresets'

export function usePreprocessingPreset() {
  const [preset, setPresetState] = useState<PreprocessingPreset>(DEFAULT_PREPROCESSING_PRESET)

  useEffect(() => {
    window.api.invoke('prefs:load-preprocessing-preset').then(stored => {
      if (stored !== null) setPresetState(stored)
    })
  }, [])

  const set = useCallback((value: PreprocessingPreset) => {
    setPresetState(value)
    void window.api.invoke('prefs:save-preprocessing-preset', value)
  }, [])

  return { preset, set }
}
