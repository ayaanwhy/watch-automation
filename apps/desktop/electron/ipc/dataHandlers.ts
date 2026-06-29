import { ipcMain } from 'electron'
import { parseSpreadsheet, discoverImages, matchSkus } from '@wpa/processing/data'
import { logger } from '../logger'
import type { BatchLoadPayload, BatchLoadResult } from '../../src/types/ipc'

export function registerDataHandlers(): void {
  ipcMain.handle('batch:load', async (_event, payload: BatchLoadPayload): Promise<BatchLoadResult> => {
    let parsed
    try {
      parsed = parseSpreadsheet(payload.spreadsheetPath)
    } catch (err) {
      logger.error('batch:load — spreadsheet read failed', err)
      return { ok: false, errors: ['Failed to read spreadsheet file.'] }
    }

    if (parsed.errors.length > 0) {
      logger.warn(`batch:load — spreadsheet invalid: ${parsed.errors.join('; ')}`)
      return { ok: false, errors: parsed.errors }
    }

    let images
    try {
      images = discoverImages(payload.inputFolder)
    } catch (err) {
      logger.error('batch:load — image discovery failed', err)
      return { ok: false, errors: ['Failed to scan input folder.'] }
    }

    const match = matchSkus(parsed, images)
    logger.info(
      `batch:load — ${match.matched.length} matched, ` +
      `${match.missingImages.length} missing images, ` +
      `${match.missingSpreadsheetRecords.length} missing records`
    )

    return { ok: true, errors: [], match }
  })
}
