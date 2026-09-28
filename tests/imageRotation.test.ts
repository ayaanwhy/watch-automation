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

  it.each([
    [90, HEIGHT, WIDTH],
    [180, WIDTH, HEIGHT],
    [270, HEIGHT, WIDTH],
  ] as [RotationDegrees, number, number][])(
    'rotating by %d° produces the exact quarter-turn geometry (%d x %d), not a hardcoded size',
    async (degrees, expectedWidth, expectedHeight) => {
      const outputPath = join(scratchDir, `out-${degrees}.png`)
      const result = await rotateImage(inputPath, outputPath, degrees)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // 90°/270° swap width and height; 180° keeps them. Exact — a
      // quarter-turn never resamples or expands the canvas.
      expect(result.width).toBe(expectedWidth)
      expect(result.height).toBe(expectedHeight)
      const meta = await sharp(outputPath).metadata()
      expect(meta.width).toBe(expectedWidth)
      expect(meta.height).toBe(expectedHeight)
    },
  )

  it('90° and 270° rotate in opposite directions, 180° equals two quarter-turns', async () => {
    // A source whose top-left pixel is unique, so orientation is observable.
    const marked = join(scratchDir, 'marked.png')
    const buf = Buffer.alloc(WIDTH * HEIGHT * 4)
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      buf[i * 4] = 10; buf[i * 4 + 1] = 10; buf[i * 4 + 2] = 10; buf[i * 4 + 3] = 255
    }
    buf[0] = 255 // top-left red
    await sharp(buf, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toFile(marked)

    async function redAt(path: string): Promise<[number, number]> {
      const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      for (let i = 0; i < info.width * info.height; i++) {
        if (data[i * 4] === 255) return [i % info.width, Math.floor(i / info.width)]
      }
      throw new Error('marker not found')
    }

    const out90 = join(scratchDir, 'm90.png')
    const out180 = join(scratchDir, 'm180.png')
    const out270 = join(scratchDir, 'm270.png')
    await rotateImage(marked, out90, 90)
    await rotateImage(marked, out180, 180)
    await rotateImage(marked, out270, 270)
    // Clockwise: top-left ends at top-right (90), bottom-right (180), bottom-left (270).
    expect(await redAt(out90)).toEqual([HEIGHT - 1, 0])
    expect(await redAt(out180)).toEqual([WIDTH - 1, HEIGHT - 1])
    expect(await redAt(out270)).toEqual([0, WIDTH - 1])
  })

  it('a quarter-turn never introduces transparent corners on an opaque image', async () => {
    for (const degrees of [90, 180, 270] as RotationDegrees[]) {
      const outputPath = join(scratchDir, `opaque-${degrees}.png`)
      const result = await rotateImage(inputPath, outputPath, degrees)
      if (!result.ok) throw new Error(result.error)
      expect(await readAlphaAt(outputPath, 0, 0)).toBe(255)
      expect(await readAlphaAt(outputPath, result.width - 1, result.height - 1)).toBe(255)
    }
  })

  it('rejects a nonexistent source image with an error result rather than throwing', async () => {
    const result = await rotateImage(join(scratchDir, 'missing.png'), join(scratchDir, 'out.png'), 90)
    expect(result.ok).toBe(false)
  })
})
