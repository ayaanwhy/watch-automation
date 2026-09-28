// Sandbox-only workflow state (Phase 15.2, extended Phase 15.3) — the
// selected Temporary Batch, its in-progress Universal Configuration, and
// (new in 15.3) the active SandboxRun's live state. Deliberately its own
// context under src/sandbox/, not folded into App.tsx or any Legacy
// context (Phase 15 isolation rule) — mirrors PreprocessingJobContext/
// RingBraceletJobContext's exact shape (a small provider + useX() hook),
// the established pattern for cross-screen state in this app.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SandboxTemporaryBatchDetail } from '../types/sandboxTemporaryBatch'
import type { SandboxUniversalConfig } from '../types/sandboxUniversalConfig'
import { createInitialUniversalConfig } from '../types/sandboxUniversalConfig'
import type { SandboxRunDetail } from '../types/sandboxRun'
import type { SandboxProductType } from '../types/sandboxProduct'

interface SandboxWorkflowContextValue {
  selectedBatch: SandboxTemporaryBatchDetail | null
  config: SandboxUniversalConfig | null
  // Sets the selected batch and (re)initializes its configuration from
  // scratch — the one and only place a SandboxUniversalConfig is minted.
  selectBatch: (batch: SandboxTemporaryBatchDetail) => void
  updateConfig: (updater: (prev: SandboxUniversalConfig) => SandboxUniversalConfig) => void
  reset: () => void
  // The SandboxRun this workflow is currently watching, if any — set by
  // startRun (Universal Configuration's real "Review Configuration"
  // action) or resumeRun (recovering an existing in-progress run, e.g.
  // after a renderer reload). Kept fresh by subscribing to
  // 'sandbox:run-updated', never by polling.
  activeRun: SandboxRunDetail | null
  startRunError: string | null
  starting: boolean
  startRun: () => Promise<void>
  cancelRun: () => Promise<void>
  resumeRun: (runId: string) => Promise<void>
  // Retries ONE failed image of the active run; resolves with the engine's
  // refusal reason (if any) — progress then arrives via the normal events.
  retryImage: (productType: SandboxProductType, sku: string) => Promise<string | null>
  clearActiveRun: () => void
}

const SandboxWorkflowContext = createContext<SandboxWorkflowContextValue | null>(null)

export function SandboxWorkflowProvider({ children }: { children: ReactNode }) {
  const [selectedBatch, setSelectedBatch] = useState<SandboxTemporaryBatchDetail | null>(null)
  const [config, setConfig] = useState<SandboxUniversalConfig | null>(null)
  const [activeRun, setActiveRun] = useState<SandboxRunDetail | null>(null)
  const [starting, setStarting] = useState(false)
  const [startRunError, setStartRunError] = useState<string | null>(null)
  // The engine starts publishing state the moment a job is created — before
  // sandbox:start-run has even returned its runId. These refs let the
  // subscription below adopt those early events (rather than dropping them
  // and looking stale until the next one).
  const startingRef = useRef(false)
  const selectedBatchIdRef = useRef<string | null>(null)
  selectedBatchIdRef.current = selectedBatch?.id ?? null

  const selectBatch = useCallback((batch: SandboxTemporaryBatchDetail) => {
    setSelectedBatch(batch)
    setConfig(createInitialUniversalConfig(batch))
  }, [])

  const updateConfig = useCallback((updater: (prev: SandboxUniversalConfig) => SandboxUniversalConfig) => {
    setConfig(prev => (prev ? updater(prev) : prev))
  }, [])

  const reset = useCallback(() => {
    setSelectedBatch(null)
    setConfig(null)
    setActiveRun(null)
    setStartRunError(null)
  }, [])

  const clearActiveRun = useCallback(() => setActiveRun(null), [])

  // Live progress — one subscription for the whole provider, filtered by
  // whichever run is currently being watched. No polling.
  useEffect(() => {
    return window.api.on('sandbox:run-updated', payload => {
      setActiveRun(prev => {
        if (prev) return prev.id === payload.id && payload.updatedAt >= prev.updatedAt ? payload : prev
        // No run tracked yet: adopt the one this workflow is in the middle of starting.
        return startingRef.current && payload.temporaryBatchId === selectedBatchIdRef.current ? payload : prev
      })
    })
  }, [])

  const startRun = useCallback(async () => {
    if (!selectedBatch || !config) return
    setStarting(true)
    startingRef.current = true
    setStartRunError(null)
    try {
      const result = await window.api.invoke('sandbox:start-run', { batch: selectedBatch, config })
      if (!result.ok || !result.runId) {
        // Structured failure: headline + what to do next, not a bare error.
        setStartRunError(result.failure ? [result.failure.message, result.failure.action].filter(Boolean).join(' ') : (result.error ?? 'Failed to start this Sandbox run.'))
        return
      }
      const run = await window.api.invoke('sandbox:get-run', { id: result.runId })
      // Never let this snapshot overwrite a newer state already streamed in.
      setActiveRun(prev => (prev && run && prev.id === run.id && prev.updatedAt > run.updatedAt ? prev : run))
    } catch (err) {
      setStartRunError(err instanceof Error ? err.message : 'Failed to start this Sandbox run.')
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }, [selectedBatch, config])

  const cancelRun = useCallback(async () => {
    if (!activeRun) return
    await window.api.invoke('sandbox:cancel-run', { id: activeRun.id })
  }, [activeRun])

  const resumeRun = useCallback(async (runId: string) => {
    const run = await window.api.invoke('sandbox:get-run', { id: runId })
    setActiveRun(run)
  }, [])

  const retryImage = useCallback(
    async (productType: SandboxProductType, sku: string): Promise<string | null> => {
      if (!activeRun) return 'No active run.'
      const result = await window.api.invoke('sandbox:retry-image', { runId: activeRun.id, productType, sku })
      if (result.ok) return null
      return result.failure ? [result.failure.message, result.failure.action].filter(Boolean).join(' ') : (result.error ?? 'Could not retry this image.')
    },
    [activeRun],
  )

  const value = useMemo(
    () => ({
      selectedBatch,
      config,
      selectBatch,
      updateConfig,
      reset,
      activeRun,
      startRunError,
      starting,
      startRun,
      cancelRun,
      resumeRun,
      retryImage,
      clearActiveRun,
    }),
    [selectedBatch, config, selectBatch, updateConfig, reset, activeRun, startRunError, starting, startRun, cancelRun, resumeRun, retryImage, clearActiveRun],
  )

  return <SandboxWorkflowContext.Provider value={value}>{children}</SandboxWorkflowContext.Provider>
}

export function useSandboxWorkflow() {
  const ctx = useContext(SandboxWorkflowContext)
  if (!ctx) throw new Error('useSandboxWorkflow must be used within a SandboxWorkflowProvider')
  return ctx
}
