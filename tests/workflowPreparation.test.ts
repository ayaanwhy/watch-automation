// Phase 12A — resizeToHeight validation for prepareForEditingHandoff, plus a
// regression check that trim/rotate-only callers (Watch/Ring/Bracelet) are
// unaffected when the new field is omitted. electron mocked (app.getPath →
// scratch dir) since workflowPreparation.ts's logger import needs it —
// same pattern as batchRegistryRecovery.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
}))

async function writeTestImage(path: string, width: number, height: number): Promise<void> {
  const buf = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = 180
    buf[i * 4 + 1] = 150
    buf[i * 4 + 2] = 80
    buf[i * 4 + 3] = 255 // fully opaque — trim's alpha-bounding-box covers the whole frame
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

describe('prepareForEditingHandoff — resizeToHeight (Phase 12A)', () => {
  let sourceDir: string

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-handoff-resize-test-'))
    sourceDir = join(scratchDir, 'source')
    await mkdir(sourceDir, { recursive: true })
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('normalizes a larger image down to exactly the target height, aspect preserved', async () => {
    const { prepareForEditingHandoff } = await import('../apps/desktop/electron/services/workflowPreparation.js')
    await writeTestImage(join(sourceDir, 'a.png'), 2400, 1600) // 3:2 aspect

    const result = await prepareForEditingHandoff(sourceDir, { trim: false, rotate: 'none', resizeToHeight: 1000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const meta = await sharp(join(result.preparedDir, 'a.png')).metadata()
    expect(meta.height).toBe(1000)
    expect(meta.width).toBe(1500) // 2400/1600 * 1000, aspect preserved
  })

  it('unconditionally enlarges a smaller image up to the target height (intentional — 1000px is a fixed canvas basis, not a cap)', async () => {
    const { prepareForEditingHandoff } = await import('../apps/desktop/electron/services/workflowPreparation.js')
    await writeTestImage(join(sourceDir, 'small.png'), 400, 300) // 4:3, well under 1000

    const result = await prepareForEditingHandoff(sourceDir, { trim: false, rotate: 'none', resizeToHeight: 1000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const meta = await sharp(join(result.preparedDir, 'small.png')).metadata()
    expect(meta.height).toBe(1000)
    expect(meta.width).toBe(1333) // 400/300 * 1000, rounded
  })

  it('applies resize after rotate — target height reflects the post-rotation orientation', async () => {
    const { prepareForEditingHandoff } = await import('../apps/desktop/electron/services/workflowPreparation.js')
    // Source is wide (600x300); rotating 90° makes it tall (300x600) before resize.
    await writeTestImage(join(sourceDir, 'wide.png'), 600, 300)

    const result = await prepareForEditingHandoff(sourceDir, { trim: false, rotate: 'cw', resizeToHeight: 1000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const meta = await sharp(join(result.preparedDir, 'wide.png')).metadata()
    // Post-rotation aspect is 300:600 = 1:2, so height=1000 -> width=500.
    expect(meta.height).toBe(1000)
    expect(meta.width).toBe(500)
  })

  it('regression: trim+rotate-only callers (resizeToHeight omitted) produce unresized output, exactly as before this phase', async () => {
    const { prepareForEditingHandoff } = await import('../apps/desktop/electron/services/workflowPreparation.js')
    await writeTestImage(join(sourceDir, 'watch.png'), 800, 500)

    const withResize = await prepareForEditingHandoff(sourceDir, { trim: true, rotate: 'ccw' }, undefined)
    expect(withResize.ok).toBe(true)
    if (!withResize.ok) return

    const meta = await sharp(join(withResize.preparedDir, 'watch.png')).metadata()
    // ccw rotation of a fully-opaque 800x500 image, trimmed to its own full
    // bounding box (a no-op here since every pixel is opaque): dimensions
    // swap to 500x800, and critically are NOT further resized to any fixed
    // height — proving the new step is fully inert when omitted.
    expect(meta.width).toBe(500)
    expect(meta.height).toBe(800)
  })
})
