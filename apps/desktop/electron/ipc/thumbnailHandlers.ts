import { ipcMain } from 'electron'
import { getThumbnail } from '../services/thumbnailCache'
import type { ThumbnailGetPayload, ThumbnailGetResult } from '../../src/types/ipc'

// Review-sidebar thumbnail performance (Item 6, post-Phase-13 polish) — see
// thumbnailCache.ts for the full rationale.
export function registerThumbnailHandlers(): void {
  ipcMain.handle('thumbnail:get', async (_event, payload: ThumbnailGetPayload): Promise<ThumbnailGetResult> =>
    getThumbnail(payload.path),
  )
}
