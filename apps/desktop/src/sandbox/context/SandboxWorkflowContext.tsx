// Sandbox-only workflow state (Phase 15.2) — the selected Temporary Batch
// and its in-progress Universal Configuration. Deliberately its own
// context under src/sandbox/, not folded into App.tsx or any Legacy
// context (Phase 15 isolation rule) — mirrors PreprocessingJobContext/
// RingBraceletJobContext's exact shape (a small provider + useX() hook),
// the established pattern for cross-screen state in this app.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { SandboxTemporaryBatchDetail } from '../types/sandboxTemporaryBatch'
import type { SandboxUniversalConfig } from '../types/sandboxUniversalConfig'
import { createInitialUniversalConfig } from '../types/sandboxUniversalConfig'

interface SandboxWorkflowContextValue {
  selectedBatch: SandboxTemporaryBatchDetail | null
  config: SandboxUniversalConfig | null
  // Sets the selected batch and (re)initializes its configuration from
  // scratch — the one and only place a SandboxUniversalConfig is minted.
  selectBatch: (batch: SandboxTemporaryBatchDetail) => void
  updateConfig: (updater: (prev: SandboxUniversalConfig) => SandboxUniversalConfig) => void
  reset: () => void
}

const SandboxWorkflowContext = createContext<SandboxWorkflowContextValue | null>(null)

export function SandboxWorkflowProvider({ children }: { children: ReactNode }) {
  const [selectedBatch, setSelectedBatch] = useState<SandboxTemporaryBatchDetail | null>(null)
  const [config, setConfig] = useState<SandboxUniversalConfig | null>(null)

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
  }, [])

  const value = useMemo(
    () => ({ selectedBatch, config, selectBatch, updateConfig, reset }),
    [selectedBatch, config, selectBatch, updateConfig, reset],
  )

  return <SandboxWorkflowContext.Provider value={value}>{children}</SandboxWorkflowContext.Provider>
}

export function useSandboxWorkflow() {
  const ctx = useContext(SandboxWorkflowContext)
  if (!ctx) throw new Error('useSandboxWorkflow must be used within a SandboxWorkflowProvider')
  return ctx
}
