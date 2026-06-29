import { ipcMain } from 'electron'
import { join } from 'node:path'
import { processWatch } from '@wpa/processing'
import { logger } from '../logger'
import type { ProcessWatchPayload, ProcessWatchResult } from '../../src/types/ipc'

function classifyError(err: unknown): string {
  const msg = String(err)
  if (msg.includes('ENOENT')) return 'Watch image file not found'
  if (msg.includes('EACCES') || msg.includes('EPERM')) return 'Permission denied reading watch image'
  if (msg.includes('must be a PNG') || msg.includes('Input image')) return 'File is not a valid PNG image'
  if (msg.includes('readable dimensions')) return 'PNG image has no readable dimensions'
  return msg
}

export async function runProcessWatch(payload: ProcessWatchPayload): Promise<ProcessWatchResult> {
  const { spliceBoundaries, scaleBoundaries, sku, inputFolder, outputFolder, widthMm } = payload

  if (spliceBoundaries.leftBoundary >= spliceBoundaries.rightBoundary) {
    return { ok: false, sku, error: 'Splice left boundary must be less than right boundary' }
  }

  if (widthMm <= 0) {
    return { ok: false, sku, error: 'Width measurement must be greater than 0 mm' }
  }

  const inputPath = join(inputFolder, `${sku}.png`)
  const outputPath = join(outputFolder, `${sku};frontImage.png`)
  const startedAt = Date.now()

  logger.info(`Processing ${sku} — width ${widthMm}mm`)

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
    const ms = Date.now() - startedAt
    logger.info(`Processed ${sku} in ${ms}ms → ${result.outputPath}`)
    return { ok: true, sku, outputPath: result.outputPath }
  } catch (err) {
    const ms = Date.now() - startedAt
    const message = classifyError(err)
    logger.error(`Failed ${sku} after ${ms}ms — ${message}`)
    return { ok: false, sku, error: message }
  }
}

export function registerProcessHandlers(): void {
  ipcMain.handle('process:watch', async (_event, payload: ProcessWatchPayload): Promise<ProcessWatchResult> => {
    return runProcessWatch(payload)
  })
}
