// Sandbox-only 'None' preprocessing operation (Phase 15.1) — bypasses both
// background removal and upscaling entirely and copies source images
// straight through to an Editing-ready output folder. Deliberately just a
// file copy: no sharp transform, and critically no Python subprocess is
// spawned (contrast with ../ipc/preprocessHandlers.ts's runner, which
// always spawns preprocessing/UBG/electron_runner.py for every other
// operation choice) — 'None' means "use the images as-is."
//
// Sandbox-only by construction: this file lives under electron/sandbox/,
// is never imported from electron/ipc/ (see
// tests/sandboxNonePreprocessing.test.ts's source-scan regression check),
// and Legacy's PreprocessOperation type (../../src/types/ipc.ts) has no
// 'none' value for any Legacy code path to construct in the first place.
import { readdir, copyFile, mkdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'

// Same supported extensions the other pipelines' validate-input handlers
// check (see ringBraceletHandlers.ts/earringHandlers.ts), plus jpg/jpeg —
// 'None' has no format constraint of its own since nothing decodes the
// pixels, unlike those pipelines' Python runners.
const SUPPORTED_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg'])

export interface SandboxNonePreprocessingResult {
  ok: boolean
  imageCount: number
  skippedCount: number
  error?: string
}

export async function runSandboxNonePreprocessing(
  inputDir: string,
  outputDir: string,
): Promise<SandboxNonePreprocessingResult> {
  try {
    const s = await stat(inputDir)
    if (!s.isDirectory()) {
      return { ok: false, imageCount: 0, skippedCount: 0, error: `Input path is not a directory: ${inputDir}` }
    }
  } catch {
    return { ok: false, imageCount: 0, skippedCount: 0, error: `Input directory not found: ${inputDir}` }
  }

  let names: string[]
  try {
    const entries = await readdir(inputDir, { withFileTypes: true })
    names = entries
      .filter(e => e.isFile() && !e.name.startsWith('._') && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map(e => e.name)
  } catch (err) {
    return { ok: false, imageCount: 0, skippedCount: 0, error: `Failed to read input directory: ${String(err)}` }
  }

  if (names.length === 0) {
    return { ok: false, imageCount: 0, skippedCount: 0, error: 'No supported images found in the input folder.' }
  }

  try {
    await mkdir(outputDir, { recursive: true })
  } catch (err) {
    return { ok: false, imageCount: 0, skippedCount: 0, error: `Could not create output directory: ${String(err)}` }
  }

  const outcomes = await Promise.allSettled(
    names.map(name => copyFile(join(inputDir, name), join(outputDir, name))),
  )
  const skippedCount = outcomes.filter(o => o.status === 'rejected').length
  const imageCount = names.length - skippedCount

  if (imageCount === 0) {
    return { ok: false, imageCount: 0, skippedCount, error: 'All images failed to copy.' }
  }

  return { ok: true, imageCount, skippedCount }
}
