import { useCallback, useEffect, useState } from 'react'
import type { SamTuningPrefs } from '../types/ipc'

// Defaults mirror the current config.py SAM values so the panel is pre-populated
// correctly even before the user has ever saved custom preferences.
const DEFAULTS: SamTuningPrefs = {
  pointsPerSide: 32,
  pointsPerBatch: 16,
  predIouThresh: 0.8,
  stabilityScoreThresh: 0.92,
  maxMasks: 32,
  multimaskOutput: true,
}

export function useSamTuning() {
  const [prefs, setPrefs] = useState<SamTuningPrefs>(DEFAULTS)

  // Load persisted values once on mount, falling back to defaults if none saved.
  useEffect(() => {
    window.api.invoke('prefs:load-sam-tuning').then((stored) => {
      if (stored !== null) setPrefs(stored)
    })
  }, [])

  const update = useCallback(<K extends keyof SamTuningPrefs>(key: K, value: SamTuningPrefs[K]) => {
    setPrefs(prev => {
      const next = { ...prev, [key]: value }
      void window.api.invoke('prefs:save-sam-tuning', next)
      return next
    })
  }, [])

  return { prefs, update }
}
