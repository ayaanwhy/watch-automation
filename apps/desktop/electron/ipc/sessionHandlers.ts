import { ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_VERSION } from '../../src/types/session'
import type { SessionFile } from '../../src/types/session'
import type { SessionSavePayload, SessionSaveResult, SessionLoadPayload, SessionLoadResult } from '../../src/types/ipc'

function sessionFileName(inputFolder: string, spreadsheetPath: string): string {
  const hash = createHash('sha256')
    .update(inputFolder + '|' + spreadsheetPath)
    .digest('hex')
    .slice(0, 12)
  return `wpa-session-${hash}.json`
}

function sessionFilePath(outputFolder: string, inputFolder: string, spreadsheetPath: string): string {
  return join(outputFolder, sessionFileName(inputFolder, spreadsheetPath))
}

export function registerSessionHandlers(): void {
  ipcMain.handle('session:save', async (_event, payload: SessionSavePayload): Promise<SessionSaveResult> => {
    try {
      const filePath = sessionFilePath(
        payload.outputFolder,
        payload.session.inputFolder,
        payload.session.spreadsheetPath
      )
      const tmpPath = filePath + '.tmp'
      await writeFile(tmpPath, JSON.stringify(payload.session, null, 2), 'utf-8')
      await rename(tmpPath, filePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('session:load', async (_event, payload: SessionLoadPayload): Promise<SessionLoadResult> => {
    const filePath = sessionFilePath(payload.outputFolder, payload.inputFolder, payload.spreadsheetPath)
    const tmpPath = filePath + '.tmp'

    let raw: string | null = null
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch {
      try {
        raw = await readFile(tmpPath, 'utf-8')
      } catch {
        return { ok: true, session: null }
      }
    }

    try {
      const session = JSON.parse(raw) as SessionFile
      // Migrate v1 → v2: processingStatus/processingError fields were added in v2.
      // v1 annotations simply won't have them; context initializer defaults them to null.
      if (session.version === 1) {
        session.version = SESSION_VERSION
      }
      if (session.version !== SESSION_VERSION) return { ok: true, session: null }
      if (session.inputFolder !== payload.inputFolder) return { ok: true, session: null }
      if (session.spreadsheetPath !== payload.spreadsheetPath) return { ok: true, session: null }
      return { ok: true, session }
    } catch {
      return { ok: true, session: null, error: 'Session file could not be parsed' }
    }
  })
}
