import { ipcMain } from 'electron'
import { join } from 'node:path'
import { processWatch } from '@wpa/processing'
import type { ProcessWatchPayload, ProcessWatchResult } from '../../src/types/ipc'

export async function runProcessWatch(payload: ProcessWatchPayload): Promise<ProcessWatchResult> {
  const { spliceBoundaries, scaleBoundaries, sku, inputFolder, outputFolder, widthMm } = payload

  if (spliceBoundaries.leftBoundary >= spliceBoundaries.rightBoundary) {
    return { ok: false, sku, error: 'Splice left boundary must be less than right boundary' }
  }

  const inputPath = join(inputFolder, `${sku}.png`)
  const outputPath = join(outputFolder, `${sku};frontImage.png`)

  try {
    const result = await processWatch({
      inputPath,
      outputPath,
      widthMm,
      leftBoundary: spliceBoundaries.leftBoundary,
      rightBoundary: spliceBoundaries.rightBoundary,
      scaleLeft: scaleBoundaries?.leftBoundary,
      scaleRight: scaleBoundaries?.rightBoundary,
    })
    return { ok: true, sku, outputPath: result.outputPath }
  } catch (err) {
    return { ok: false, sku, error: String(err) }
  }
}

export function registerProcessHandlers(): void {
  ipcMain.handle('process:watch', async (_event, payload: ProcessWatchPayload): Promise<ProcessWatchResult> => {
    return runProcessWatch(payload)
  })
}
