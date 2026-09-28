// Sandbox IPC surface (Phase 15.2, extended Phase 15.3) — the renderer <->
// main boundary for the Sandbox Dashboard/Universal Configuration/
// execution UI. Deliberately thin: every handler forwards to
// sandboxApiClient or sandboxOrchestrator/sandboxRunRegistry — matching
// every other *Handlers.ts file's "logic lives in services/, this just
// wires IPC to it" convention (see boundaryHandlers.ts). The renderer never
// drives execution itself: sandbox:start-run kicks off the real work in
// the main process and returns immediately; live progress arrives via the
// 'sandbox:run-updated' event (see sandboxOrchestrator.ts's
// notifyAllWindows calls), not by the renderer polling or orchestrating.
import { ipcMain } from 'electron'
import { sandboxApiClient } from '../sandbox/sandboxApiClient'
import { resolveTemporaryBatchDetail } from '../sandbox/temporaryBatchResolver'
import { listLocalTestBatches } from '../sandbox/localLegacyBatchSource'
import { automationEngine } from '../sandbox/engine/automationEngine'
import { notifyAllWindows } from '../services/subprocessRunner'
import { getSandboxReviewItems, approveSandboxItems, rejectSandboxItems } from '../sandbox/sandboxReviewService'
import type { SandboxTemporaryBatchDetail, SandboxTemporaryBatchSummary } from '../../src/sandbox/types/sandboxTemporaryBatch'
import type { SandboxRunDetail, SandboxRunSummary } from '../../src/sandbox/types/sandboxRun'
import type { SandboxUniversalConfig } from '../../src/sandbox/types/sandboxUniversalConfig'
import type {
  SandboxReviewItem,
  SandboxReviewItemKeyInput,
  SandboxDispositionActionResult,
} from '../../src/sandbox/types/sandboxReview'
import type { SandboxEditor } from '../../src/sandbox/types/sandboxDisposition'
import type { AutomationError } from '../../src/sandbox/types/automationError'
import type { SandboxProductType } from '../../src/sandbox/types/sandboxProduct'
import { isLocalTestBatchId } from '../../src/sandbox/types/sandboxLocalTestBatch'
import type { SandboxLocalTestBatchListResult } from '../../src/sandbox/types/sandboxLocalTestBatch'

const RUN_UPDATED_CHANNEL = 'sandbox:run-updated'

// This file is the Electron TRANSPORT ADAPTER around the Automation Engine
// (electron/sandbox/engine/automationEngine.ts): it forwards IPC calls to the
// engine and forwards the engine's structured job-state events to the
// renderer windows. Every execution decision lives in the engine.
export function registerSandboxHandlers(): void {
  automationEngine.subscribeToJobProgress(state => notifyAllWindows(RUN_UPDATED_CHANNEL, state))

  ipcMain.handle('sandbox:list-temporary-batches', async (): Promise<SandboxTemporaryBatchSummary[]> => {
    return sandboxApiClient.listTemporaryBatches()
  })

  ipcMain.handle(
    'sandbox:get-temporary-batch-detail',
    async (_event, payload: { id: string }): Promise<SandboxTemporaryBatchDetail | null> => {
      return resolveTemporaryBatchDetail(payload.id)
    },
  )

  // DEVELOPMENT/TESTING ONLY — existing local Legacy batches offered as a
  // Temporary Batch source (see localLegacyBatchSource.ts). Read-only; the
  // detail for a chosen one is fetched through
  // sandbox:get-temporary-batch-detail like any other batch id.
  ipcMain.handle('sandbox:list-local-test-batches', async (): Promise<SandboxLocalTestBatchListResult> => {
    return listLocalTestBatches()
  })

  // Validates, preflights, creates the SandboxRun, and begins execution in
  // the background — see sandboxOrchestrator.startSandboxRun's own doc
  // comment for exactly what "begins" means (not awaited here).
  ipcMain.handle(
    'sandbox:start-run',
    async (
      _event,
      payload: { batch: SandboxTemporaryBatchDetail; config: SandboxUniversalConfig },
    ): Promise<{ ok: boolean; runId?: string; error?: string; failure?: AutomationError }> => {
      // A local test batch is re-resolved from the Legacy registry here —
      // the renderer's copy (in particular its file paths) is never
      // trusted for one, only its id.
      let batch = payload.batch
      if (isLocalTestBatchId(batch.id)) {
        const resolved = await resolveTemporaryBatchDetail(batch.id)
        if (!resolved) return { ok: false, error: 'This local test batch could not be loaded. Its Legacy batch or source folder may no longer be available.' }
        batch = resolved
      }
      return automationEngine.submitJob(batch, payload.config)
    },
  )

  ipcMain.handle('sandbox:cancel-run', async (_event, payload: { id: string }): Promise<{ ok: boolean }> => {
    return automationEngine.cancelJob(payload.id)
  })

  // Recovery/state-fetch (a simple IPC round trip is fine for this — see
  // Phase 15.3's own "if a simple IPC state fetch is needed for recovery,
  // that is fine" allowance). Live updates while a run is actually
  // progressing come from the 'sandbox:run-updated' event instead.
  ipcMain.handle('sandbox:get-run', async (_event, payload: { id: string }): Promise<SandboxRunDetail | null> => {
    return automationEngine.getJobState(payload.id)
  })

  // Retry ONE failed image of an existing run (see AutomationEngine.retryImage).
  ipcMain.handle(
    'sandbox:retry-image',
    async (_event, payload: { runId: string; productType: SandboxProductType; sku: string }): Promise<{ ok: boolean; error?: string; failure?: AutomationError }> => {
      return automationEngine.retryImage(payload.runId, payload.productType, payload.sku)
    },
  )

  ipcMain.handle('sandbox:list-runs', async (): Promise<SandboxRunSummary[]> => {
    return automationEngine.listJobs()
  })

  // Final Review (Phase 15.6) — every handler here forwards to
  // sandboxReviewService.ts, which is the one place review items are
  // assembled and approve/reject + handoff actually happen. The renderer
  // never talks to sandboxApiClient or the Legacy batch registry directly.
  ipcMain.handle('sandbox:get-review-items', async (_event, payload: { id: string }): Promise<SandboxReviewItem[] | null> => {
    return getSandboxReviewItems(payload.id)
  })

  ipcMain.handle('sandbox:list-editors', async (): Promise<SandboxEditor[]> => {
    return sandboxApiClient.listEditors()
  })

  ipcMain.handle(
    'sandbox:approve-items',
    async (_event, payload: { runId: string; keys: SandboxReviewItemKeyInput[] }): Promise<SandboxDispositionActionResult> => {
      return approveSandboxItems(payload.runId, payload.keys)
    },
  )

  ipcMain.handle(
    'sandbox:reject-items',
    async (
      _event,
      payload: { runId: string; keys: SandboxReviewItemKeyInput[]; reason: string; instructions?: string | null; editor: SandboxEditor | null },
    ): Promise<SandboxDispositionActionResult> => {
      return rejectSandboxItems(payload.runId, {
        keys: payload.keys,
        reason: payload.reason,
        instructions: payload.instructions,
        editor: payload.editor,
      })
    },
  )
}
