import { ipcMain } from 'electron'
import * as registry from '../services/batchRegistry'
import type { BatchDetailRecord, BatchSummaryRecord } from '../../src/types/batch'
import type {
  BatchCreatePayload,
  BatchStageUpdatePayload,
  BatchRenamePayload,
} from '../../src/types/ipc'

// Thin handlers over the batch registry service (Phase 9B). All logic and
// persistence live in services/batchRegistry.ts + services/batchModel.ts.
export function registerBatchRegistryHandlers(): void {
  ipcMain.handle('batch-registry:create', async (_e, p: BatchCreatePayload): Promise<BatchDetailRecord> =>
    registry.createBatch({ sourceDir: p.sourceDir, pipeline: p.pipeline, title: p.title }),
  )

  ipcMain.handle('batch-registry:list', async (): Promise<BatchSummaryRecord[]> =>
    registry.listBatches(),
  )

  ipcMain.handle('batch-registry:get', async (_e, p: { id: string }): Promise<BatchDetailRecord | null> =>
    registry.getBatch(p.id),
  )

  ipcMain.handle('batch-registry:update-stage', async (_e, p: BatchStageUpdatePayload): Promise<BatchDetailRecord | null> =>
    registry.updateStage(p.id, p.stageType, p.patch),
  )

  ipcMain.handle('batch-registry:rename', async (_e, p: BatchRenamePayload): Promise<BatchDetailRecord | null> =>
    registry.renameBatch(p.id, p.title),
  )
}
