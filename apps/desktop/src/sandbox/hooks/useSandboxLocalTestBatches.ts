// DEVELOPMENT/TESTING ONLY — loads the existing local Legacy batches offered
// as a test source (see electron/sandbox/localLegacyBatchSource.ts). Lazy on
// purpose: listing reads each batch's source folder (often an external
// drive), so nothing is scanned until the operator opens the local-test
// section.
import { useCallback, useState } from 'react'
import type { SandboxLocalTestBatchListResult } from '../types/sandboxLocalTestBatch'

export function useSandboxLocalTestBatches() {
  const [result, setResult] = useState<SandboxLocalTestBatchListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    window.api
      .invoke('sandbox:list-local-test-batches')
      .then(setResult)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load local batches.'))
      .finally(() => setLoading(false))
  }, [])

  return { result, loading, error, load }
}
