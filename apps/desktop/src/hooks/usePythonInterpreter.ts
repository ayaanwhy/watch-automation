import { useCallback, useEffect, useState } from 'react'

export function usePythonInterpreter() {
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)
  const [resolving, setResolving] = useState(true)
  const [override, setOverride] = useState('')

  const resolve = useCallback(async () => {
    setResolving(true)
    try {
      const result = await window.api.invoke('preprocess:resolve-python')
      setResolvedPath(result.pythonPath)
    } finally {
      setResolving(false)
    }
  }, [])

  // Auto-resolve once on entering the page.
  useEffect(() => {
    resolve()
  }, [resolve])

  const trimmedOverride = override.trim()
  const effectivePath = trimmedOverride !== '' ? trimmedOverride : resolvedPath
  const isValid = !resolving && effectivePath !== null && effectivePath !== ''

  return {
    resolvedPath,
    resolving,
    override,
    setOverride,
    effectivePath,
    isValid,
    refresh: resolve,
  }
}
