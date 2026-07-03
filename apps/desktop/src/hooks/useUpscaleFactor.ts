import { useCallback, useEffect, useState } from 'react'
import type { UpscaleFactor } from '../types/ipc'

export function useUpscaleFactor() {
  const [scaleFactor, setScaleFactor] = useState<UpscaleFactor>(1)

  useEffect(() => {
    window.api.invoke('prefs:load-upscale-factor').then(stored => {
      if (stored !== null) setScaleFactor(stored)
    })
  }, [])

  const set = useCallback((value: UpscaleFactor) => {
    setScaleFactor(value)
    void window.api.invoke('prefs:save-upscale-factor', value)
  }, [])

  return { scaleFactor, set }
}
