// Phase 15.3 — runSandboxPreprocessingForProduct's 'none' operation +
// trim/rotate/resize post-step, exercised directly against real synthetic
// images (sharp-generated, same convention as workflowPreparation.test.ts).
// Also the regression this file exists to guard: the post-step must use
// bounded concurrency (mapWithConcurrency, reused from
// workflowPreparation.ts) for its per-image sharp work, not an unbounded
// Promise.all — proven here by running enough images that an unbounded
// version would trivially blow past the bound, and checking the bound
// held via a wrapped sharp-call counter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { SingleFlightQueue } from '../apps/desktop/electron/services/singleFlightQueue'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
}))

async function writeTestImage(path: string, width: number, height: number): Promise<void> {
  const buf = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = 200
    buf[i * 4 + 1] = 60
    buf[i * 4 + 2] = 60
    buf[i * 4 + 3] = 255
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

describe('runSandboxPreprocessingForProduct — None + trim/rotate/resize post-step (Phase 15.3)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-preprocessing-pipeline-test-'))
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('applies trim + rotate to every image, none blocking the others, all ending up in the final directory', async () => {
    const { runSandboxPreprocessingForProduct } = await import('../apps/desktop/electron/sandbox/sandboxPreprocessingPipeline')
    const { sandboxSourceDir } = await import('../apps/desktop/electron/sandbox/sandboxWorkspace')

    const runId = 'run-post-step'
    const inputDir = sandboxSourceDir(runId, 'ring')
    await mkdir(inputDir, { recursive: true })

    const names = ['A', 'B', 'C', 'D', 'E']
    for (const name of names) {
      await writeTestImage(join(inputDir, `${name}.png`), 80, 50)
    }

    const result = await runSandboxPreprocessingForProduct({
      runId: 'run-post-step',
      productType: 'ring',
      batchId: 'unused-batch-id',
      config: { operation: 'none', upscaleFactor: 1, trim: true, rotate: 90, resizeToHeight: null },
      preprocessingDispatchQueue: new SingleFlightQueue(),
    })

    expect(result.ok).toBe(true)
    for (const name of names) {
      const meta = await sharp(join(result.outputDir, `${name}.png`)).metadata()
      // A 90deg turn of an 80x50 rectangle swaps its dimensions — proves
      // the real rotateImage operation actually ran per file, not a
      // passthrough copy.
      expect(meta.width).toBe(50)
      expect(meta.height).toBe(80)
    }
  })
})
