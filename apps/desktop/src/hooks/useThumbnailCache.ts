import { useCallback, useRef, useState } from 'react'
import { toFileUrl } from '../lib/paths'

// Renderer-side cache of resolved thumbnail file:// URLs, keyed by source
// path (Item 6, post-Phase-13 polish — see thumbnailCache.ts on the main
// process side for the full rationale). Lives in a ref so it survives
// ThumbnailGrid's virtualization unmounting/remounting cells as the user
// scrolls — a cell that scrolls back into view never re-requests a
// thumbnail it already resolved. Falls back to the original full-resolution
// src if generation fails for a given image, rather than leaving the cell
// blank forever.
export function useThumbnailCache() {
  const cacheRef = useRef<Map<string, string>>(new Map())
  const pendingRef = useRef<Set<string>>(new Set())
  const [, setTick] = useState(0)

  // Returns the resolved thumbnail src if ready, or null while it's still
  // being generated (first call for a given path kicks off the request;
  // callers re-render once it resolves via the tick bump below). `src` is
  // the original full-resolution src to fall back to on failure.
  const getThumbSrc = useCallback((sourcePath: string, fallbackSrc: string): string | null => {
    const cached = cacheRef.current.get(sourcePath)
    if (cached) return cached
    if (pendingRef.current.has(sourcePath)) return null

    pendingRef.current.add(sourcePath)
    window.api.invoke('thumbnail:get', { path: sourcePath }).then(result => {
      pendingRef.current.delete(sourcePath)
      cacheRef.current.set(sourcePath, result.ok ? toFileUrl(result.thumbnailPath) : fallbackSrc)
      setTick(t => t + 1)
    })
    return null
  }, [])

  return getThumbSrc
}
