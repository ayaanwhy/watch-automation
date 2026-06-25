import { ipcMain } from 'electron'
import { join } from 'node:path'
import { processWatch } from '@wpa/processing'
import type { ProcessWatchPayload, ProcessWatchResult } from '../../src/types/ipc'

export function registerProcessHandlers(): void {
  ipcMain.handle('process:watch', async (_event, payload: ProcessWatchPayload): Promise<ProcessWatchResult> => {
    if (payload.leftBoundary >= payload.rightBoundary) {
      return { ok: false, sku: payload.sku, error: 'Left boundary must be less than right boundary' }
    }

    const inputPath = join(payload.inputFolder, `${payload.sku}.png`)
    const outputPath = join(payload.outputFolder, `${payload.sku};frontImage.png`)

    try {
      const result = await processWatch({
        inputPath,
        outputPath,
        widthMm: payload.widthMm,
        leftBoundary: payload.leftBoundary,
        rightBoundary: payload.rightBoundary,
      })
      return { ok: true, sku: payload.sku, outputPath: result.outputPath }
    } catch (err) {
      return { ok: false, sku: payload.sku, error: String(err) }
    }
  })
}
