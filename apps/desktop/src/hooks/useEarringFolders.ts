import { useCallback, useEffect, useRef, useState } from 'react'

// Mirrors useRingBraceletFolders' shape, but a single shared slot rather
// than product-keyed (see EarringFolderPrefs in types/ipc.ts) — there's only
// one Earring product to remember folders for. Bundles the metadata sheet
// path alongside the two folders, since all three are "this screen's
// last-used inputs" together.
export function useEarringFolders() {
  const [inputDir, setInputDirState] = useState('')
  const [outputDir, setOutputDirState] = useState('')
  const [metadataFilePath, setMetadataFilePathState] = useState('')

  const inputRef = useRef('')
  const outputRef = useRef('')
  const metadataRef = useRef('')

  useEffect(() => {
    window.api.invoke('prefs:load-earring-folders').then(prefs => {
      if (prefs.inputDir) {
        setInputDirState(prefs.inputDir)
        inputRef.current = prefs.inputDir
      }
      if (prefs.outputDir) {
        setOutputDirState(prefs.outputDir)
        outputRef.current = prefs.outputDir
      }
      if (prefs.metadataFilePath) {
        setMetadataFilePathState(prefs.metadataFilePath)
        metadataRef.current = prefs.metadataFilePath
      }
    })
  }, [])

  const persist = useCallback(() => {
    void window.api.invoke('prefs:save-earring-folders', {
      inputDir: inputRef.current || null,
      outputDir: outputRef.current || null,
      metadataFilePath: metadataRef.current || null,
    })
  }, [])

  const setInputDir = useCallback((path: string) => {
    inputRef.current = path
    setInputDirState(path)
    persist()
  }, [persist])

  const setOutputDir = useCallback((path: string) => {
    outputRef.current = path
    setOutputDirState(path)
    persist()
  }, [persist])

  const setMetadataFilePath = useCallback((path: string) => {
    metadataRef.current = path
    setMetadataFilePathState(path)
    persist()
  }, [persist])

  return { inputDir, outputDir, metadataFilePath, setInputDir, setOutputDir, setMetadataFilePath }
}
