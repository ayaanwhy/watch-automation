// Phase 15.1 — Shared Rotation image operation. No electron dependency
// (rotateImage takes explicit file paths), so no vi.mock('electron', ...)
// is needed here, unlike most other electron/services/*.test.ts files.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { rotateImage } from '../apps/desktop/electron/services/imageRotation'
import type { RotationDegrees } from '../apps/desktop/src/constants/rotation'

let scratchDir: string
let inputPath: string

const WIDTH = 100
const HEIGHT = 60

async function writeOpaqueTestImage(path: string, width: number, height: number): Promise<void> {
  const buf = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = 200
    buf[i * 4 + 1] = 40
    buf[i * 4 + 2] = 40
    buf[i * 4 + 3] = 255 // fully opaque — every pixel is "the subject"
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

// Exact trigonometric bounding box for a w x h rectangle rotated by
// `degrees` — this is the real geometry the task requires the output to
// match, computed independently of whatever sharp does internally.
function expectedRotatedBoundingBox(width: number, height: number, degrees: number): { width: number; height: number } {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  }
}

async function readAlphaAt(path: string, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const idx = (y * info.width + x) * info.channels + (info.channels - 1)
  return data[idx]
}

describe('rotateImage (Phase 15.1 — shared Rotation operation)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-rotation-test-'))
    inputPath = join(scratchDir, 'input.png')
    await writeOpaqueTestImage(inputPath, WIDTH, HEIGHT)
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('0° preserves existing identity behavior — byte-for-byte, unchanged dimensions', async () => {
    const outputPath = join(scratchDir, 'out-0.png')
    const result = await rotateImage(inputPath, outputPath, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.width).toBe(WIDTH)
    expect(result.height).toBe(HEIGHT)

    const inputBytes = await readFile(inputPath)
    const outputBytes = await readFile(outputPath)
    expect(outputBytes.equals(inputBytes)).toBe(true)
  })

  it.each([45, -45, 135, -135] as RotationDegrees[])(
    'rotating by %d° produces the exact rotated bounding box, not a hardcoded size',
    async (degrees) => {
      const outputPath = join(scratchDir, `out-${degrees}.png`)
      const result = await rotateImage(inputPath, outputPath, degrees)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const expected = expectedRotatedBoundingBox(WIDTH, HEIGHT, degrees)
      // Small tolerance for sharp's own internal rounding — the point of
      // this assertion is that the output matches the real geometry, not
      // that it matches some other hardcoded constant.
      expect(Math.abs(result.width - expected.width)).toBeLessThanOrEqual(2)
      expect(Math.abs(result.height - expected.height)).toBeLessThanOrEqual(2)

      // Different rotation angles must not all collapse to the same size —
      // proves dimensions are actually derived from the angle.
      expect(result.width).not.toBe(WIDTH)
      expect(result.height).not.toBe(HEIGHT)
    },
  )

  it.each([45, -45, 135, -135] as RotationDegrees[])(
    'rotating by %d° leaves the newly-exposed canvas corners transparent',
    async (degrees) => {
      const outputPath = join(scratchDir, `out-corners-${degrees}.png`)
      const result = await rotateImage(inputPath, outputPath, degrees)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // A rotated rectangle inscribed in its own bounding box never
      // reaches the bounding box's own corners (true for any of these
      // four diagonal angles on a non-square source) — so every corner of
      // the output canvas must be outside the rotated subject, i.e.
      // transparent.
      const corners: [number, number][] = [
        [0, 0],
        [result.width - 1, 0],
        [0, result.height - 1],
        [result.width - 1, result.height - 1],
      ]
      for (const [x, y] of corners) {
        const alpha = await readAlphaAt(outputPath, x, y)
        expect(alpha).toBe(0)
      }
    },
  )

  it('rejects a nonexistent source image with an error result rather than throwing', async () => {
    const result = await rotateImage(join(scratchDir, 'missing.png'), join(scratchDir, 'out.png'), 45)
    expect(result.ok).toBe(false)
  })
})
