import { useCallback, useEffect, useRef, useState } from 'react'

// Mirrors usePreprocessingFolders' shape, product-keyed — Ring and Bracelet
// remember separate folders rather than sharing one slot (see
// RingBraceletFolderPrefs in types/ipc.ts for why). Re-loads whenever
// `product` changes, since switching products on the shared Editing setup
// screen should show that product's own remembered folders, not the
// previous one's.
export function useRingBraceletFolders(product: 'ring' | 'bracelet') {
  const [inputDir, setInputDirState] = useState('')
  const [outputDir, setOutputDirState] = useState('')

  const inputRef = useRef('')
  const outputRef = useRef('')

  useEffect(() => {
    inputRef.current = ''
    outputRef.current = ''
    setInputDirState('')
    setOutputDirState('')
    window.api.invoke('prefs:load-ring-bracelet-folders', { product }).then(prefs => {
      if (prefs.inputDir) {
        setInputDirState(prefs.inputDir)
        inputRef.current = prefs.inputDir
      }
      if (prefs.outputDir) {
        setOutputDirState(prefs.outputDir)
        outputRef.current = prefs.outputDir
      }
    })
  }, [product])

  const setInputDir = useCallback((path: string) => {
    inputRef.current = path
    setInputDirState(path)
    void window.api.invoke('prefs:save-ring-bracelet-folders', {
      product,
      inputDir: path,
      outputDir: outputRef.current || null,
    })
  }, [product])

  const setOutputDir = useCallback((path: string) => {
    outputRef.current = path
    setOutputDirState(path)
    void window.api.invoke('prefs:save-ring-bracelet-folders', {
      product,
      inputDir: inputRef.current || null,
      outputDir: path,
    })
  }, [product])

  return { inputDir, outputDir, setInputDir, setOutputDir }
}
