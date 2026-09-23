// Sandbox IPC surface (Phase 15.2) — the renderer <-> main boundary for the
// Sandbox Dashboard/Universal Configuration UI. Deliberately thin: every
// handler just forwards to sandboxApiClient (currently MockSandboxApiClient
// — see ../sandbox/sandboxApiClient.ts), matching every other *Handlers.ts
// file's "logic lives in services/, this just wires IPC to it" convention
// (see boundaryHandlers.ts). No execution, no orchestration — this phase is
// read-only Temporary Batch access only.
import { ipcMain } from 'electron'
import { sandboxApiClient } from '../sandbox/sandboxApiClient'
import type { SandboxTemporaryBatchDetail, SandboxTemporaryBatchSummary } from '../../src/sandbox/types/sandboxTemporaryBatch'

export function registerSandboxHandlers(): void {
  ipcMain.handle('sandbox:list-temporary-batches', async (): Promise<SandboxTemporaryBatchSummary[]> => {
    return sandboxApiClient.listTemporaryBatches()
  })

  ipcMain.handle(
    'sandbox:get-temporary-batch-detail',
    async (_event, payload: { id: string }): Promise<SandboxTemporaryBatchDetail | null> => {
      return sandboxApiClient.getTemporaryBatchDetail(payload.id)
    },
  )
}
