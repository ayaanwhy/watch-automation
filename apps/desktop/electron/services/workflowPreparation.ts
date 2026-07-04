import sharp from 'sharp'
import { readdir, rm, mkdir, stat } from 'node:fs/promises'
import { join, basename, dirname, extname } from 'node:path'
import { logger } from '../logger'
import type { PrepareForWatchProcessingResult } from '../../src/types/ipc'

// Generic home for logic that prepares one module's output for use as
// another module's input. Currently has a single consumer (Preprocessing →
// Watch Processing) but is named for the workflow-integration concern, not
// the specific pair of modules, so future hand-offs can live here too.

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

// Sibling folder, never nested inside sourceDir — keeps the original
// preprocessing output completely untouched and makes the prepared copy
// easy to find in Finder/Explorer right next to it.
function preparedDirFor(sourceDir: string): string {
  const parent = dirname(sourceDir)
  const name = basename(sourceDir)
  return join(parent, `${name} - WatchReady`)
}

async function findSourceImages(sourceDir: string): Promise<string[]> {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort()
}

// Scans the raw alpha channel for the exact bounding box of non-transparent
// (alpha > 0) pixels. Precise by construction — unlike sharp's built-in
// trim() (a fuzzy corner-color-similarity heuristic), this responds only to
// alpha, matching "outermost non-transparent pixel" exactly.
// Returns null when the image has no non-transparent pixels at all.
async function computeAlphaBoundingBox(
  inputPath: string
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha() // images without an alpha channel become fully opaque —
    .raw()         // bounding box then naturally covers the whole frame.
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  const alphaIndex = channels - 1

  let minX = width, maxX = -1, minY = height, maxY = -1
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * channels
    for (let x = 0; x < width; x++) {
      if (data[rowOffset + x * channels + alphaIndex] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0) return null // fully transparent — degenerate, nothing to trim to
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// Bounded-concurrency map — large batches at 4x upscale can hold tens of MB
// of raw pixel data per in-flight image, so unbounded Promise.all could spike
// memory unnecessarily.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = items[nextIndex++]
      await fn(current)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * Prepares a completed preprocessing output folder for use as Watch
 * Processing's input folder: trims each image to its non-transparent
 * bounding box, rotates it 90° counter-clockwise, and writes the result into
 * a new "<sourceDir> - WatchReady" sibling folder.
 *
 * The original sourceDir is only ever read, never written to.
 * Per-image failures (corrupt file, fully-transparent image) are skipped
 * rather than aborting the whole batch; the call only fails outright when
 * zero images could be prepared.
 */
export async function prepareForWatchProcessing(
  sourceDir: string,
  onProgress?: (completed: number, total: number) => void
): Promise<PrepareForWatchProcessingResult> {
  try {
    const sourceStat = await stat(sourceDir)
    if (!sourceStat.isDirectory()) {
      return { ok: false, error: `Preprocessing output path is not a folder: ${sourceDir}` }
    }
  } catch {
    return { ok: false, error: `Preprocessing output folder not found: ${sourceDir}` }
  }

  let imageNames: string[]
  try {
    imageNames = await findSourceImages(sourceDir)
  } catch (err) {
    return { ok: false, error: `Failed to read preprocessing output folder: ${String(err)}` }
  }

  if (imageNames.length === 0) {
    return { ok: false, error: 'No images found in the preprocessing output folder.' }
  }

  const preparedDir = preparedDirFor(sourceDir)

  try {
    // Clear + recreate so re-running preprocessing into the same output
    // folder and clicking Continue again never mixes stale images from a
    // previous run with the new set.
    await rm(preparedDir, { recursive: true, force: true })
    await mkdir(preparedDir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `Could not create prepared folder next to the output directory: ${String(err)}` }
  }

  const total = imageNames.length
  let completed = 0
  let skipped = 0

  await mapWithConcurrency(imageNames, 3, async (name) => {
    const inputPath = join(sourceDir, name)
    const outputPath = join(preparedDir, name)
    try {
      const bbox = await computeAlphaBoundingBox(inputPath)
      if (bbox === null) {
        throw new Error('image has no non-transparent pixels')
      }
      await sharp(inputPath).extract(bbox).rotate(-90).toFile(outputPath)
    } catch (err) {
      skipped++
      logger.warn(`prepareForWatchProcessing — skipped ${name}: ${String(err)}`)
    } finally {
      completed++
      onProgress?.(completed, total)
    }
  })

  const imageCount = total - skipped
  if (imageCount === 0) {
    return { ok: false, error: 'All images failed during preparation. Check the source folder and try again.' }
  }

  return { ok: true, preparedDir, imageCount, skippedCount: skipped }
}
