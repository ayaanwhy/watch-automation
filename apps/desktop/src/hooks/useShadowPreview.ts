import { useEffect, useRef, useState } from 'react'
import type { ShadowProfileValues } from '../constants/shadowProfiles'

interface ShadowPreviewState {
  previewPath: string | null
  rendering: boolean
  error: string | null
}

// Debounced, real Python-backed preview (Phase 13H) — re-renders ~400ms
// after the last edit to `values` settles, the same debounce shape
// useSessionAutosave.ts already uses elsewhere in this app. Every render
// goes through shadow-preview:render (preprocessing/shadow_preview.py), the
// same compositing engine every production runner calls — never a CSS
// approximation. requestIdRef discards a response that arrives after a
// newer edit has already superseded it (possible since renders aren't
// instant and typing doesn't wait for one to finish).
export function useShadowPreview(values: ShadowProfileValues): ShadowPreviewState {
  const [state, setState] = useState<ShadowPreviewState>({ previewPath: null, rendering: true, error: null })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setState(prev => ({ ...prev, rendering: true }))

    timerRef.current = setTimeout(async () => {
      const requestId = ++requestIdRef.current
      const result = await window.api.invoke('shadow-preview:render', { values })
      if (requestId !== requestIdRef.current) return
      if (result.ok) {
        setState({ previewPath: result.previewPath, rendering: false, error: null })
      } else {
        setState(prev => ({ previewPath: prev.previewPath, rendering: false, error: result.error }))
      }
    }, 400)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [values])

  return state
}
