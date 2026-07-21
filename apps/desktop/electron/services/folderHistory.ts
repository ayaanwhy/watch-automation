// Per-selector "last used location" memory (Phase 9E.1) — replaces relying
// on the OS dialog's own shared/global last-directory behavior, which made
// every picker (Input Folder, Output Folder, Spreadsheet, ...) appear to
// share one remembered location instead of each having its own. Purely an
// implementation detail of the dialog handlers in batchHandlers.ts; not
// exposed as its own IPC channel.

import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../logger'
import { atomicWriteJson } from './atomicFile'

const FILENAME = 'folder-history.json'

function filePath(): string {
  return join(app.getPath('userData'), FILENAME)
}

async function loadAll(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(filePath(), 'utf-8')) as Record<string, string>
  } catch (err) {
    // ENOENT is normal on first run; anything else (corrupt JSON, permission
    // error) previously vanished with no diagnostic trail (Phase 11A fix).
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('folder-history — failed to read folder-history.json', err)
    }
    return {}
  }
}

export async function getRecentPath(key: string): Promise<string | undefined> {
  const all = await loadAll()
  return all[key]
}

export async function setRecentPath(key: string, path: string): Promise<void> {
  try {
    const all = await loadAll()
    all[key] = path
    // Phase 11E: was a direct writeFile — a crash mid-write could leave a
    // truncated file that then failed every future read.
    await atomicWriteJson(filePath(), all)
  } catch (err) {
    // Non-critical — a picker simply won't remember its last location — but
    // now at least logged instead of vanishing silently (Phase 11A fix).
    logger.warn('folder-history — failed to write folder-history.json', err)
  }
}
