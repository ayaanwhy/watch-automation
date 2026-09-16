// Watch AI boundary-detection endpoint override (Phase 14B) — the deployment
// is still moving (it was undeployed entirely until 2026-09-15), so the URL
// must be operator-configurable, never hardcoded. One shared file rather
// than duplicating the read in both prefsHandlers.ts (renderer-facing
// load/save) and boundaryDetection.ts (resolving the effective endpoint
// before a request) — same "small service, one source of truth" shape as
// preprocessingPresetDefinitions.ts.
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../logger'
import { atomicWriteJson } from './atomicFile'

const FILENAME = 'boundary-endpoint.json'

function filePath(): string {
  return join(app.getPath('userData'), FILENAME)
}

export async function loadBoundaryEndpoint(): Promise<string | null> {
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const v = JSON.parse(raw)
    return typeof v === 'string' && v.trim() !== '' ? v : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn(`boundary-endpoint-prefs — failed to read ${FILENAME}`, err)
    }
    return null
  }
}

export async function saveBoundaryEndpoint(value: string | null): Promise<void> {
  try {
    const trimmed = value?.trim() ?? null
    await atomicWriteJson(filePath(), trimmed && trimmed !== '' ? trimmed : null)
  } catch (err) {
    logger.warn(`boundary-endpoint-prefs — failed to write ${FILENAME}`, err)
  }
}
