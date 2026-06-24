import { ipcMain } from 'electron'
import { parseSpreadsheet, discoverImages, matchSkus } from '@wpa/processing/data'
import type { BatchLoadPayload, BatchLoadResult } from '../../src/types/ipc'

export function registerDataHandlers(): void {
  ipcMain.handle('batch:load', async (_event, payload: BatchLoadPayload): Promise<BatchLoadResult> => {
    let parsed
    try {
      parsed = parseSpreadsheet(payload.spreadsheetPath)
    } catch (err) {
      return { ok: false, errors: ['Failed to read spreadsheet file.'] }
    }

    if (parsed.errors.length > 0) {
      return { ok: false, errors: parsed.errors }
    }

    let images
    try {
      images = discoverImages(payload.inputFolder)
    } catch (err) {
      return { ok: false, errors: ['Failed to scan input folder.'] }
    }

    const match = matchSkus(parsed, images)

    return { ok: true, errors: [], match }
  })
}
