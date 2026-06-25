import { ipcMain, app } from 'electron'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { LastBatchPrefs } from '../../src/types/ipc'

const PREFS_FILENAME = 'last-batch.json'

function prefsFilePath(): string {
  return join(app.getPath('userData'), PREFS_FILENAME)
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

export function registerPrefsHandlers(): void {
  ipcMain.handle('prefs:load-last-batch', async (): Promise<LastBatchPrefs> => {
    try {
      const raw = await readFile(prefsFilePath(), 'utf-8')
      const stored = JSON.parse(raw) as Partial<LastBatchPrefs>

      const [inOk, shOk, outOk] = await Promise.all([
        stored.inputFolder    ? exists(stored.inputFolder)    : Promise.resolve(false),
        stored.spreadsheetPath? exists(stored.spreadsheetPath): Promise.resolve(false),
        stored.outputFolder   ? exists(stored.outputFolder)   : Promise.resolve(false),
      ])

      return {
        inputFolder:     inOk  ? stored.inputFolder!     : null,
        spreadsheetPath: shOk  ? stored.spreadsheetPath! : null,
        outputFolder:    outOk ? stored.outputFolder!    : null,
      }
    } catch {
      return { inputFolder: null, spreadsheetPath: null, outputFolder: null }
    }
  })

  ipcMain.handle('prefs:save-last-batch', async (_event, payload: LastBatchPrefs): Promise<void> => {
    try {
      await writeFile(prefsFilePath(), JSON.stringify(payload, null, 2), 'utf-8')
    } catch {
      // Prefs are non-critical; silently ignore write failures.
    }
  })
}
