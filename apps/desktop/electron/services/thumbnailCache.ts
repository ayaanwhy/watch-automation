import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { logger } from '../logger'

// Review-sidebar thumbnail performance (Item 6, post-Phase-13 polish).
// ThumbnailGrid's cells previously pointed straight at each source image's
// full-resolution file — a 92px CSS cell forcing a full decode of whatever
// the pipeline produced (often several megapixels). Virtualization, lazy
// loading, and async decoding were all already in place (confirmed by
// inspection — see ThumbnailCell.tsx); the actual bottleneck was decode
// cost, not list rendering, so the fix is a real downscaled thumbnail, not
// more lazy-loading. `sharp` was already a dependency and already used in
// the main process (workflowPreparation.ts) — reused here rather than
// adding a new image library.
//
// Cached to disk under userData, keyed by the source file's own path +
// mtime + size, so a re-processed/replaced image regenerates rather than
// serving a stale thumbnail, and a repeat visit to the same batch across
// app restarts reuses the cache instead of re-encoding. No eviction policy
// — thumbnails are a few KB each; pruning wasn't judged worth the added
// complexity for this pass.
const THUMB_MAX_DIMENSION = 200

function cacheDir(): string {
  return join(app.getPath('userData'), 'thumbnail-cache')
}

function cacheKeyFor(sourcePath: string, mtimeMs: number, size: number): string {
  return createHash('sha1').update(`${sourcePath}:${mtimeMs}:${size}`).digest('hex')
}

// De-dupes concurrent requests for the same source path (e.g. the renderer
// re-requesting before the first call resolves) so two ThumbnailGrid cells
// mounting at once never both invoke sharp on the same file.
const inFlight = new Map<string, Promise<string>>()

export type ThumbnailResult = { ok: true; thumbnailPath: string } | { ok: false; error: string }

export async function getThumbnail(sourcePath: string): Promise<ThumbnailResult> {
  try {
    const existing = inFlight.get(sourcePath)
    if (existing) return { ok: true, thumbnailPath: await existing }

    const promise = (async () => {
      const st = await stat(sourcePath)
      const outPath = join(cacheDir(), `${cacheKeyFor(sourcePath, st.mtimeMs, st.size)}.webp`)

      // Cheap existence check beats re-decoding + re-encoding on every request.
      try {
        await stat(outPath)
        return outPath
      } catch {
        // Not cached yet — fall through and generate.
      }

      await mkdir(cacheDir(), { recursive: true })
      await sharp(sourcePath)
        .resize(THUMB_MAX_DIMENSION, THUMB_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(outPath)
      return outPath
    })()

    inFlight.set(sourcePath, promise)
    try {
      const thumbnailPath = await promise
      return { ok: true, thumbnailPath }
    } finally {
      inFlight.delete(sourcePath)
    }
  } catch (err) {
    logger.warn(`thumbnail-cache — failed to generate thumbnail for ${sourcePath}`, err)
    return { ok: false, error: String(err) }
  }
}
