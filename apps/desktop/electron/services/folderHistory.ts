// Per-selector "last used location" memory (Phase 9E.1) — replaces relying
// on the OS dialog's own shared/global last-directory behavior, which made
// every picker (Input Folder, Output Folder, Spreadsheet, ...) appear to
// share one remembered location instead of each having its own. Purely an
// implementation detail of the dialog handlers in batchHandlers.ts; not
// exposed as its own IPC channel.

import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FILENAME = 'folder-history.json'

function filePath(): string {
  return join(app.getPath('userData'), FILENAME)
}

async function loadAll(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(filePath(), 'utf-8')) as Record<string, string>
  } catch {
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
    await writeFile(filePath(), JSON.stringify(all, null, 2), 'utf-8')
  } catch {
    // Non-critical — a picker simply won't remember its last location.
  }
}
