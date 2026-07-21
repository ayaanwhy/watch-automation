// Crash-safe JSON persistence (Phase 11E) — write-to-temp-then-rename so a
// reader never observes a partially-written file: a crash mid-write leaves
// either the old complete file or the new complete file, never a half-
// written one. batchRegistry.ts and sessionHandlers.ts already used this
// pattern inline before this phase; prefsHandlers.ts and folderHistory.ts
// used a direct writeFile (not crash-safe) — this is now the one shared
// implementation for any caller that needs it.
import { writeFile, rename } from 'node:fs/promises'

export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmp, path)
}
