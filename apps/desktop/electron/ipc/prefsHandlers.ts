import { ipcMain, app } from 'electron'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { LastBatchPrefs, SamTuningPrefs, UpscaleFactor } from '../../src/types/ipc'

const PREFS_FILENAME = 'last-batch.json'
const SAM_TUNING_PREFS_FILENAME = 'sam-tuning.json'

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

  // ── SAM tuning prefs ────────────────────────────────────────────────────────
  // Returns null when no prefs have been saved yet; the renderer then falls
  // back to its own hard-coded defaults (which match config.py).
  ipcMain.handle('prefs:load-sam-tuning', async (): Promise<SamTuningPrefs | null> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), SAM_TUNING_PREFS_FILENAME), 'utf-8')
      return JSON.parse(raw) as SamTuningPrefs
    } catch {
      return null
    }
  })

  ipcMain.handle('prefs:save-sam-tuning', async (_event, payload: SamTuningPrefs): Promise<void> => {
    try {
      await writeFile(join(app.getPath('userData'), SAM_TUNING_PREFS_FILENAME), JSON.stringify(payload, null, 2), 'utf-8')
    } catch { /* non-critical */ }
  })

  // ── Upscale factor pref ─────────────────────────────────────────────────────
  ipcMain.handle('prefs:load-upscale-factor', async (): Promise<UpscaleFactor | null> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), 'upscale-factor.json'), 'utf-8')
      const v = JSON.parse(raw)
      if (v === 1 || v === 2 || v === 4) return v as UpscaleFactor
      return null
    } catch {
      return null
    }
  })

  ipcMain.handle('prefs:save-upscale-factor', async (_event, payload: UpscaleFactor): Promise<void> => {
    try {
      await writeFile(join(app.getPath('userData'), 'upscale-factor.json'), JSON.stringify(payload), 'utf-8')
    } catch { /* non-critical */ }
  })
}
