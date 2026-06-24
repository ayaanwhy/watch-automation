import { useEffect, useState } from 'react'

export interface WatchImageState {
  element: HTMLImageElement | null
  naturalWidth: number
  naturalHeight: number
  loaded: boolean
  error: boolean
}

const INITIAL: WatchImageState = {
  element: null,
  naturalWidth: 0,
  naturalHeight: 0,
  loaded: false,
  error: false,
}

export function useWatchImage(filePath: string | null): WatchImageState {
  const [state, setState] = useState<WatchImageState>(INITIAL)

  useEffect(() => {
    if (!filePath) return
    setState(INITIAL)

    const img = new window.Image()
    const url = `file://${filePath.replace(/\\/g, '/')}`
    console.log('[useWatchImage] filePath:', filePath)
    console.log('[useWatchImage] url:', url)

    img.onload = () => {
      setState({
        element: img,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        loaded: true,
        error: false,
      })
    }
    img.onerror = (event) => {
      console.log('[useWatchImage] onerror — filePath:', filePath)
      console.log('[useWatchImage] onerror — url:', url)
      console.log('[useWatchImage] onerror — event:', event)
      setState({ element: null, naturalWidth: 0, naturalHeight: 0, loaded: true, error: true })
    }
    img.src = url

    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [filePath])

  return state
}
