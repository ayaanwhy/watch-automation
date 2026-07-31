// Phase 12C — the blocking regression gate for the shadow engine promotion
// (preprocessing/RingBracelet/shadow.py -> preprocessing/shadow.py, plus
// the horizontal_falloff/casting_region/canvas_base/trim_output extensions
// added alongside the move). Runs the real Ring & Bracelet Python pipeline
// end-to-end against a fixed, deterministic synthetic image and asserts
// byte-for-byte identical output against frozen golden hashes.
//
// The golden hashes below were captured by running this exact fixture
// through the pre-extension shadow.py (at its original
// preprocessing/RingBracelet/shadow.py location) and confirmed identical
// against the promoted+extended version via a direct before/after
// comparison at both the shadow-function level (4 image sizes/aspects) and
// this full-pipeline level, before Parts 2-4 of Phase 12C began. If this
// test ever fails, RING_BRACELET_SHADOW's behavior has regressed — every
// new capability (horizontal_falloff, casting_region, canvas_base,
// trim_output) is designed to default to a no-op specifically so this
// can't happen by construction, but this test is what actually proves it.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const PYTHON = '/Users/apple/miniconda3/bin/python'
const RUNNER_PATH = join(process.cwd(), 'preprocessing', 'RingBracelet', 'runner.py')

const GOLDEN_FRONT_FULL_MD5 = 'c0547b5cb2927c6b4c68ce5565181cd6'
const GOLDEN_FRONT_IMAGE_MD5 = '7dfd1edd8c158cd25acb9f14529b075d'

async function writeGoldenFixture(path: string): Promise<void> {
  // Deterministic bracelet-shaped ring, no randomness — must stay pixel-for-
  // pixel identical to the fixture the golden hashes above were captured
  // from. Do not "clean up" or restyle this generator without recapturing
  // the golden hashes against the new output first.
  const width = 500
  const height = 380
  const buf = Buffer.alloc(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4
      const dx = (x - cx) / (width * 0.35)
      const dy = (y - cy) / (height * 0.35)
      const dist = Math.sqrt(dx * dx + dy * dy)
      const onRing = dist > 0.55 && dist < 1.0
      buf[idx] = 180
      buf[idx + 1] = 150
      buf[idx + 2] = 80
      buf[idx + 3] = onRing ? 255 : 0
    }
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

async function md5File(path: string): Promise<string> {
  const data = await readFile(path)
  return createHash('md5').update(data).digest('hex')
}

describe('shadow engine promotion — Ring & Bracelet golden-image regression gate (Phase 12C)', () => {
  it('produces byte-identical output to the pre-promotion shadow.py implementation', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'wpa-shadow-gate-test-'))
    const inputDir = join(scratchDir, 'input')
    const outputDir = join(scratchDir, 'output')
    await mkdir(inputDir, { recursive: true })
    await mkdir(outputDir, { recursive: true })

    try {
      await writeGoldenFixture(join(inputDir, 'GOLD001.png'))

      execFileSync(PYTHON, [
        RUNNER_PATH,
        '--input-dir', inputDir,
        '--output-dir', outputDir,
        '--product', 'bracelet',
        '--processing-mode', 'automatic',
      ], { timeout: 30_000 })

      const frontFullMd5 = await md5File(join(outputDir, 'GOLD001;frontFullImage.png'))
      const frontImageMd5 = await md5File(join(outputDir, 'GOLD001;frontImage.png'))

      expect(frontFullMd5).toBe(GOLDEN_FRONT_FULL_MD5)
      expect(frontImageMd5).toBe(GOLDEN_FRONT_IMAGE_MD5)
    } finally {
      await rm(scratchDir, { recursive: true, force: true })
    }
  }, 30_000)
})
