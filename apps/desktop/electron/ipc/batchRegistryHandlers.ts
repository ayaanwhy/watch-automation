import { ipcMain } from 'electron'
import * as registry from '../services/batchRegistry'
import type { BatchDetailRecord, BatchSummaryRecord } from '../../src/types/batch'
import type {
  BatchCreatePayload,
  BatchStageUpdatePayload,
  BatchRenamePayload,
  BatchSetModePayload,
  BatchFindWatchPayload,
  BatchFindEditingPayload,
  BatchSetImageNeedsFixingPayload,
  BatchSetHoopSplitPayload,
} from '../../src/types/ipc'

// Thin handlers over the batch registry service (Phase 9B). All logic and
// persistence live in services/batchRegistry.ts + services/batchModel.ts.
export function registerBatchRegistryHandlers(): void {
  ipcMain.handle('batch-registry:create', async (_e, p: BatchCreatePayload): Promise<BatchDetailRecord> =>
    registry.createBatch({ sourceDir: p.sourceDir, pipeline: p.pipeline, title: p.title, mode: p.mode }),
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

  ipcMain.handle('batch-registry:set-mode', async (_e, p: BatchSetModePayload): Promise<BatchDetailRecord | null> =>
    registry.setBatchMode(p.id, p.mode),
  )

  ipcMain.handle('batch-registry:find-watch', async (_e, p: BatchFindWatchPayload): Promise<BatchDetailRecord | null> =>
    registry.findWatchBatch(p.inputFolder, p.outputFolder, p.spreadsheetPath),
  )

  ipcMain.handle('batch-registry:find-editing', async (_e, p: BatchFindEditingPayload): Promise<BatchDetailRecord | null> =>
    registry.findEditingBatch(p.product, p.inputFolder, p.outputFolder),
  )

  ipcMain.handle('batch-registry:delete', async (_e, p: { id: string }): Promise<boolean> =>
    registry.deleteBatch(p.id),
  )

  ipcMain.handle('batch-registry:set-image-needs-fixing', async (_e, p: BatchSetImageNeedsFixingPayload): Promise<BatchDetailRecord | null> =>
    registry.setImageNeedsFixing(p.id, p.stageType, p.imageName, p.needsFixing),
  )

  ipcMain.handle('batch-registry:set-hoop-split', async (_e, p: BatchSetHoopSplitPayload): Promise<BatchDetailRecord | null> =>
    registry.setHoopSplit(p.id, p.stageType, p.sku, p.splitX),
  )
}
