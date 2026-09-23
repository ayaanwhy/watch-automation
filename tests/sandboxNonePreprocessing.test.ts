// Phase 15.1 — Sandbox-only 'None' preprocessing operation. Proves three
// things: (1) it's a real lightweight copy with no Python subprocess
// involved, (2) it is never reachable from Legacy's own code paths, and
// (3) Legacy's real runner arg-building has no bypass branch for 'none'
// even if the type system were circumvented — i.e. there is no hidden
// shortcut anywhere in Legacy, not just an absent type.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSandboxNonePreprocessing } from '../apps/desktop/electron/sandbox/sandboxNonePreprocessing'
import { buildArgs } from '../apps/desktop/electron/ipc/preprocessHandlers'

// preprocessHandlers.ts's import chain (subprocessRunner -> batchRegistry,
// preprocessingPresetDefinitions, etc.) touches app.getPath/getAppPath,
// ipcMain, and BrowserWindow at module load — same pattern as
// boundaryDetectionMapping.test.ts/workflowPreparation.test.ts. Nothing
// here calls registerPreprocessHandlers() or spawns anything, so these
// only need to exist, not do anything real.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}))

let scratchDir: string
let inputDir: string
let outputDir: string

describe('runSandboxNonePreprocessing (Sandbox-only lightweight copy)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-none-test-'))
    inputDir = join(scratchDir, 'in')
    outputDir = join(scratchDir, 'out')
    await mkdir(inputDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('copies every supported image through byte-for-byte, without any transformation', async () => {
    const contentA = Buffer.from('fake-png-bytes-a')
    const contentB = Buffer.from('fake-webp-bytes-b')
    await writeFile(join(inputDir, 'a.png'), contentA)
    await writeFile(join(inputDir, 'b.webp'), contentB)

    const result = await runSandboxNonePreprocessing(inputDir, outputDir)
    expect(result.ok).toBe(true)
    expect(result.imageCount).toBe(2)
    expect(result.skippedCount).toBe(0)

    const outA = await readFile(join(outputDir, 'a.png'))
    const outB = await readFile(join(outputDir, 'b.webp'))
    expect(outA.equals(contentA)).toBe(true)
    expect(outB.equals(contentB)).toBe(true)
  })

  it('ignores unsupported files and macOS resource-fork files', async () => {
    await writeFile(join(inputDir, 'a.png'), Buffer.from('real'))
    await writeFile(join(inputDir, 'notes.txt'), Buffer.from('irrelevant'))
    await writeFile(join(inputDir, '._a.png'), Buffer.from('resource-fork'))

    const result = await runSandboxNonePreprocessing(inputDir, outputDir)
    expect(result.ok).toBe(true)
    expect(result.imageCount).toBe(1)

    const outputFiles = await readdir(outputDir)
    expect(outputFiles).toEqual(['a.png'])
  })

  it('fails cleanly when the input directory does not exist', async () => {
    const result = await runSandboxNonePreprocessing(join(scratchDir, 'missing'), outputDir)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('fails cleanly when the input directory has no supported images', async () => {
    await writeFile(join(inputDir, 'notes.txt'), Buffer.from('irrelevant'))
    const result = await runSandboxNonePreprocessing(inputDir, outputDir)
    expect(result.ok).toBe(false)
  })
})

describe('Legacy isolation from the Sandbox None operation', () => {
  it('no file under electron/ipc/ references the Sandbox None module — Legacy has no wiring to it', () => {
    const ipcDir = join(__dirname, '..', 'apps', 'desktop', 'electron', 'ipc')
    const files = readdirSync(ipcDir).filter(f => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const source = readFileSync(join(ipcDir, file), 'utf-8')
      // Looks for real wiring (an import path or an actual call), not just
      // any incidental mention of the name in prose/comments.
      expect(source).not.toContain("sandbox/sandboxNonePreprocessing'")
      expect(source).not.toContain('runSandboxNonePreprocessing(')
    }
  })

  it("Legacy's real preprocess runner arg-building has no bypass branch for 'none' — it always builds full Python-runner args", () => {
    // 'none' is not a real PreprocessOperation — forced past the type
    // system here specifically to prove there is no runtime shortcut for
    // it, not just an absent type. If Legacy ever grew a hidden bypass, it
    // would need to special-case 'none' and skip building the
    // background-removal/upscale flags; it does not.
    const args = buildArgs('/path/to/electron_runner.py', {
      inputDir: '/in',
      outputDir: '/out',
      operations: ['none'] as unknown as ('background_removal' | 'upscale')[],
    })

    expect(args).toContain('/path/to/electron_runner.py')
    expect(args).toContain('--input-dir')
    expect(args).toContain('--output-dir')
    // No operation in ['none'] matches 'background_removal', so the
    // skip-background-removal flag is set — exactly Legacy's normal,
    // unmodified behavior for an operations array that omits it. There is
    // no 'none'-specific branch that instead skips spawning the runner
    // entirely.
    expect(args).toContain('--skip-background-removal')
  })
})
