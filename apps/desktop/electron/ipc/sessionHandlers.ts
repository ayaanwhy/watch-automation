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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = JSON.parse(raw) as any

      // ── Migrations ────────────────────────────────────────────────────────────
      //
      // v1 → v4: no processing fields; no queue. Add empty queue and null boundaries.
      // v2 → v4: per-annotation processingStatus/processingError; same null-boundary treatment.
      // v3 → v4: Phase 5 queue schema. Annotations had `boundaries` (rename → spliceBoundaries,
      //          add scaleBoundaries: null). Queue items had flat leftBoundary/rightBoundary
      //          (restructure → spliceBoundaries object, add scaleBoundaries: null).
      if (parsed.version === 1 || parsed.version === 2) {
        parsed.version = SESSION_VERSION
        parsed.processingQueue = []
        if (Array.isArray(parsed.annotations)) {
          parsed.annotations = parsed.annotations.map((a: any) => ({
            sku: a.sku,
            status: a.status,
            spliceBoundaries: null,
            scaleBoundaries: null,
          }))
        }
      }

      if (parsed.version === 3) {
        parsed.version = SESSION_VERSION
        if (Array.isArray(parsed.annotations)) {
          parsed.annotations = parsed.annotations.map((a: any) => ({
            sku: a.sku,
            status: a.status,
            spliceBoundaries: a.boundaries ?? a.spliceBoundaries ?? null,
            scaleBoundaries: null,
          }))
        }
        if (Array.isArray(parsed.processingQueue)) {
          parsed.processingQueue = parsed.processingQueue.map((q: any) => ({
            id: q.id,
            sku: q.sku,
            spliceBoundaries: q.spliceBoundaries ?? {
              leftBoundary: q.leftBoundary ?? 0,
              rightBoundary: q.rightBoundary ?? 0,
            },
            scaleBoundaries: q.scaleBoundaries ?? null,
            widthMm: q.widthMm ?? 0,
            status: q.status,
            error: q.error ?? null,
            enqueuedAt: q.enqueuedAt,
            completedAt: q.completedAt ?? null,
          }))
        }
      }

      if (parsed.version !== SESSION_VERSION) return { ok: true, session: null }
      if (parsed.inputFolder !== payload.inputFolder) return { ok: true, session: null }
      if (parsed.spreadsheetPath !== payload.spreadsheetPath) return { ok: true, session: null }

      return { ok: true, session: parsed as SessionFile }
    } catch {
      return { ok: true, session: null, error: 'Session file could not be parsed' }
    }
  })
}
