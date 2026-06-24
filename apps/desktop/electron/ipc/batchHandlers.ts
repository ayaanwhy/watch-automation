import { ipcMain, dialog, BrowserWindow } from 'electron'
import { stat, readdir } from 'node:fs/promises'
import { extname } from 'node:path'
import type { OpenFileOptions, BatchValidatePayload, BatchValidationResult } from '../../src/types/ipc'

export function registerBatchHandlers(): void {
  ipcMain.handle('dialog:openFolder', async (): Promise<string | null> => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null

    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      properties: ['openDirectory']
    })

    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:openFile', async (_event, options: OpenFileOptions): Promise<string | null> => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null

    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: options?.filters ?? []
    })

    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('batch:validate', async (_event, payload: BatchValidatePayload): Promise<BatchValidationResult> => {
    const errors: string[] = []
    let imageCount: number | undefined

    try {
      const s = await stat(payload.inputFolder)
      if (!s.isDirectory()) {
        errors.push('Input folder path is not a directory.')
      } else {
        const files = await readdir(payload.inputFolder)
        imageCount = files.filter(f => extname(f).toLowerCase() === '.png').length
      }
    } catch {
      errors.push('Input folder does not exist.')
    }

    try {
      const s = await stat(payload.spreadsheetPath)
      if (!s.isFile()) {
        errors.push('Spreadsheet path is not a file.')
      } else {
        const ext = extname(payload.spreadsheetPath).toLowerCase()
        if (ext !== '.xlsx' && ext !== '.csv') {
          errors.push('Spreadsheet must be an XLSX or CSV file.')
        }
      }
    } catch {
      errors.push('Spreadsheet file does not exist.')
    }

    try {
      const s = await stat(payload.outputFolder)
      if (!s.isDirectory()) {
        errors.push('Output folder path is not a directory.')
      }
    } catch {
      errors.push('Output folder does not exist.')
    }

    return { ok: errors.length === 0, errors, imageCount }
  })
}
