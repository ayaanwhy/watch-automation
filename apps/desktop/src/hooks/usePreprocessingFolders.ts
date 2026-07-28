import { useCallback, useEffect, useRef, useState } from 'react'

// Persists both preprocessing folders as a single object so neither value
// goes stale when one is updated. Refs carry the always-current value into
// stable callbacks, following the same approach used by useUpscaleFactor
// for prefs that must be captured at call time.
export function usePreprocessingFolders() {
  const [inputDir, setInputDirState] = useState('')
  const [outputDir, setOutputDirState] = useState('')

  const inputRef  = useRef('')
  const outputRef = useRef('')

  useEffect(() => {
    window.api.invoke('prefs:load-preprocessing-folders').then(prefs => {
      if (prefs.inputDir) {
        setInputDirState(prefs.inputDir)
        inputRef.current = prefs.inputDir
      }
      if (prefs.outputDir) {
        setOutputDirState(prefs.outputDir)
        outputRef.current = prefs.outputDir
      }
    })
  }, [])

  const setInputDir = useCallback((path: string) => {
    inputRef.current = path
    setInputDirState(path)
    void window.api.invoke('prefs:save-preprocessing-folders', {
      inputDir: path,
      outputDir: outputRef.current || null,
    })
  }, [])

  const setOutputDir = useCallback((path: string) => {
    outputRef.current = path
    setOutputDirState(path)
    void window.api.invoke('prefs:save-preprocessing-folders', {
      inputDir: inputRef.current || null,
      outputDir: path,
    })
  }, [])

  return { inputDir, outputDir, setInputDir, setOutputDir }
}
