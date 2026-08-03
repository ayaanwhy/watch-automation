// Phase 11.5D — validates the two core persistence fixes end-to-end against
// the real Ring & Bracelet Python runner (not mocked): incremental progress
// persistence (subprocessRunner.ts) and idempotent reruns (runner.py).
// electron is mocked (app.getPath → scratch dir, BrowserWindow → no windows)
// so batchRegistry.ts and subprocessRunner.ts can run outside a real
// Electron process, following the same pattern as batchRegistryRecovery.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, unlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
  BrowserWindow: { getAllWindows: () => [] },
}))

const PYTHON = '/Users/apple/miniconda3/bin/python'
const RUNNER_PATH = join(process.cwd(), 'preprocessing', 'RingBracelet', 'runner.py')

function ringBraceletConfig(getRunnerPath: () => string) {
  // Mirrors ringBraceletHandlers.ts's real RunnerConfig — reconstructed here
  // rather than imported, since that module calls ipcMain.handle() at
  // require-time (registerRingBraceletHandlers), which would need ipcMain
  // mocked too for no benefit to this test.
  return {
    label: 'ring-bracelet',
    stageType: 'editing' as const,
    eventChannel: 'ring-bracelet:event',
    doneChannel: 'ring-bracelet:done',
    alreadyRunningError: 'A Ring & Bracelet job is already running',
    noPythonError: 'No suitable Python interpreter found.',
    runnerLabel: 'Ring & Bracelet runner',
    getRunnerPath,
    buildArgs: (runnerPath: string, payload: any) => {
      const args = [runnerPath, '--input-dir', payload.inputDir, '--output-dir', payload.outputDir, '--product', payload.product]
      args.push('--processing-mode', payload.processingMode ?? 'automatic')
      return args
    },
    buildStageConfig: (payload: any) => ({ product: payload.product, processingMode: payload.processingMode ?? 'automatic' }),
    mapCompleteEvent: (event: Record<string, unknown>) => {
      const frontFullImage = (event['frontFullImage'] as string) ?? null
      const frontImage = (event['frontImage'] as string) ?? null
      return {
        status: 'completed' as const,
        outputPath: frontFullImage,
        assets: {
          ...(frontFullImage ? { frontFullImage } : {}),
          ...(frontImage ? { frontImage } : {}),
          detected: Boolean(event['detected']),
        },
        error: null,
        durationMs: (event['duration_ms'] as number) ?? null,
      }
    },
  }
}

async function writeSyntheticBraceletImage(path: string): Promise<void> {
  // A small closed ring shape with a transparent background/center — small
  // (200x150) to keep each image's processing fast (Ring & Bracelet has no
  // heavy model inference, so this is CPU-bound morphology only).
  const width = 200
  const height = 150
  const buf = Buffer.alloc(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4
      const dx = (x - cx) / (width * 0.35)
      const dy = (y - cy) / (height * 0.35)
      const dist = Math.sqrt(dx * dx + dy * dy)
      const onRing = dist > 0.6 && dist < 1.0
      buf[idx] = 180
      buf[idx + 1] = 150
      buf[idx + 2] = 80
      buf[idx + 3] = onRing ? 255 : 0
    }
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

describe('subprocessRunner incremental persistence + runner.py idempotent reruns (Phase 11.5D)', () => {
  let inputDir: string
  let outputDir: string

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-rb-incremental-test-'))
    inputDir = join(scratchDir, 'input')
    outputDir = join(scratchDir, 'output')
    await mkdir(inputDir, { recursive: true })
    await mkdir(outputDir, { recursive: true })
    for (const name of ['a.png', 'b.png', 'c.png']) {
      await writeSyntheticBraceletImage(join(inputDir, name))
    }
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('writes partial progress to the batch registry before the job finishes, not only at close', async () => {
    const { createBatch, getBatch } = await import('../apps/desktop/electron/services/batchRegistry.js')
    const { createSubprocessRunner } = await import('../apps/desktop/electron/services/subprocessRunner.js')

    const batch = await createBatch({ sourceDir: inputDir, pipeline: ['editing'] })
    const runner = createSubprocessRunner(ringBraceletConfig(() => RUNNER_PATH))

    const startResult = await runner.start({
      inputDir,
      outputDir,
      batchId: batch.id,
      product: 'bracelet',
      processingMode: 'automatic',
      pythonPath: PYTHON,
    } as any)
    expect(startResult.ok).toBe(true)

    // While the job is still running, the registry should show at least one
    // completed image before all three are done — proof progress lands on
    // disk incrementally rather than only in the final close-handler write.
    const sawPartialProgress = await pollUntil(async () => {
      const detail = await getBatch(batch.id)
      const stage = detail?.stages.find(s => s.type === 'editing')
      return !!stage && stage.status === 'running' && stage.images.length > 0 && stage.images.length < 3
    }, 8000)
    expect(sawPartialProgress).toBe(true)

    // Let the job actually finish before the test tears down (avoids a
    // dangling child process outliving the test).
    const finished = await pollUntil(async () => {
      const detail = await getBatch(batch.id)
      const stage = detail?.stages.find(s => s.type === 'editing')
      return stage?.status === 'completed'
    }, 15000)
    expect(finished).toBe(true)

    const final = await getBatch(batch.id)
    const stage = final?.stages.find(s => s.type === 'editing')
    expect(stage?.counts).toEqual({ total: 3, succeeded: 3, failed: 0, cancelled: 0, needsFixing: 0, lowConfidence: 0 })
    expect(stage?.images.map(i => i.name).sort()).toEqual(['a.png', 'b.png', 'c.png'])
  }, 20000)

  it('skips an image on rerun once both its outputs exist, and reprocesses one whose output was removed', async () => {
    const { createBatch, getBatch } = await import('../apps/desktop/electron/services/batchRegistry.js')
    const { createSubprocessRunner } = await import('../apps/desktop/electron/services/subprocessRunner.js')

    const firstBatch = await createBatch({ sourceDir: inputDir, pipeline: ['editing'] })
    const runner = createSubprocessRunner(ringBraceletConfig(() => RUNNER_PATH))

    await runner.start({
      inputDir, outputDir, batchId: firstBatch.id, product: 'bracelet', processingMode: 'automatic', pythonPath: PYTHON,
    } as any)
    await pollUntil(async () => {
      const detail = await getBatch(firstBatch.id)
      return detail?.stages.find(s => s.type === 'editing')?.status === 'completed'
    }, 15000)

    const bFrontImage = join(outputDir, 'b;frontImage.png')
    const aFullPath = join(outputDir, 'a;frontFullImage.png')
    const aStatBefore = await stat(aFullPath)
    // Simulate an interrupted image: its outputs are incomplete (only one
    // of the two files survived a crash mid-write for this SKU).
    await unlink(bFrontImage)

    const secondBatch = await createBatch({ sourceDir: inputDir, pipeline: ['editing'] })
    await runner.start({
      inputDir, outputDir, batchId: secondBatch.id, product: 'bracelet', processingMode: 'automatic', pythonPath: PYTHON,
    } as any)
    await pollUntil(async () => {
      const detail = await getBatch(secondBatch.id)
      return detail?.stages.find(s => s.type === 'editing')?.status === 'completed'
    }, 15000)

    // 'a' was untouched — its output file must not have been rewritten
    // (proves it was skipped, not reprocessed).
    const aStatAfter = await stat(aFullPath)
    expect(aStatAfter.mtimeMs).toBe(aStatBefore.mtimeMs)

    // 'b' must have been regenerated — the deleted file exists again.
    const bStatAfter = await stat(bFrontImage)
    expect(bStatAfter.isFile()).toBe(true)

    const final = await getBatch(secondBatch.id)
    const stage = final?.stages.find(s => s.type === 'editing')
    expect(stage?.counts).toEqual({ total: 3, succeeded: 3, failed: 0, cancelled: 0, needsFixing: 0, lowConfidence: 0 })
  }, 30000)
})
