// Fetches the Temporary Batch list through the Sandbox IPC surface (Phase
// 15.2), backed by MockSandboxApiClient for now — see
// electron/ipc/sandboxHandlers.ts. Plain loading/error/data state, no
// caching layer — this list is small and cheap to refetch.
import { useCallback, useEffect, useState } from 'react'
import type { SandboxTemporaryBatchSummary } from '../types/sandboxTemporaryBatch'

interface UseSandboxTemporaryBatchesResult {
  batches: SandboxTemporaryBatchSummary[]
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useSandboxTemporaryBatches(): UseSandboxTemporaryBatchesResult {
  const [batches, setBatches] = useState<SandboxTemporaryBatchSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.api
      .invoke('sandbox:list-temporary-batches')
      .then(result => {
        if (cancelled) return
        setBatches(result)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load Temporary Batches.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const refetch = useCallback(() => setReloadToken(t => t + 1), [])

  return { batches, loading, error, refetch }
}
