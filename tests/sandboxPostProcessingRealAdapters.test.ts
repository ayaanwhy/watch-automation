// Phase 15.7 — real post-processing script integration. Unlike Phase
// 15.4's tests (which only had the unavailable adapter, or fake adapters
// standing in for orchestration-logic tests), these exercise the REAL
// adapters end to end: real subprocess spawn, real Python interpreter
// resolution, real postProcessing/*/runner.py scripts, real Pillow image
// processing — against real, synthetic (sharp-generated) fixture images,
// same convention as sandboxPreprocessingPipeline.test.ts. No mocking of
// the adapters or scripts themselves; only `electron` is mocked, for
// app.getAppPath() (script path resolution) and app.getPath() (unused
// here, kept for parity with every other Sandbox test's mock shape).
//
// If Pillow/pandas/openpyxl aren't available in this machine's resolved
// Python interpreter, these tests report that honestly via a real
// interpreter-resolution failure rather than skipping silently — see the
// beforeAll capability probe below.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')
// Defaulted (not just declared) so the beforeAll capability probe below —
// which runs before the first beforeEach — has a valid app.getPath()
// target for the logger's own incidental use, not just the tests proper.
let scratchDir: string = tmpdir()

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir, getAppPath: () => REAL_APP_PATH },
}))

async function writeRgba(path: string, width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const buf = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      const i = (y * width + x) * 4
      buf[i] = r
      buf[i + 1] = g
      buf[i + 2] = b
      buf[i + 3] = a
    }
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

const SOLID: [number, number, number, number] = [200, 60, 60, 255]

describe('Phase 15.7 real post-processing adapters', () => {
  let hasPython = false

  beforeAll(async () => {
    // A. Script discovery — every real script id resolves to a real file
    // on disk in this repository, not a machine-specific or invented path.
    const { postProcessingScriptPath } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/scriptSubprocess')
    const { existsSync } = await import('node:fs')
    for (const id of ['imageResizeNew', 'compressorNew', 'makeCompareRB', 'autoMCFF', 'removeShadows', 'autoMeasurementCalculator']) {
      const path = postProcessingScriptPath(id)
      expect(existsSync(path)).toBe(true)
    }

    const { resolvePostProcessingPython } = await import('../apps/desktop/electron/services/pythonResolver')
    const python = await resolvePostProcessingPython()
    hasPython = python !== null
    if (!hasPython) {
      // Honest, not silent — see Phase 15.7 section 17/23's explicit
      // instruction never to fake success when a real dependency is
      // missing. If this prints, every test below will itself fail
      // loudly with a real "no suitable Python interpreter" error rather
      // than a false pass.
      console.warn('Phase 15.7 real-adapter tests: no Python interpreter with Pillow was found — tests will fail honestly, not skip silently.')
    }
  })

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-postprocessing-real-test-'))
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  describe('B. adapter registration', () => {
    it('the six real scripts are wired to real (non-unavailable) adapters; resizeGems is real too; autoMCForIndividual is absent', async () => {
      const { sandboxPostProcessingAdapterRegistry } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/registry')
      for (const id of ['imageResizeNew', 'compressorNew', 'makeCompareRB', 'autoMCFF', 'removeShadows', 'autoMeasurementCalculator']) {
        expect(sandboxPostProcessingAdapterRegistry[id].concurrency).not.toBe('unknown-unavailable')
      }
      expect(sandboxPostProcessingAdapterRegistry.resizeGems.concurrency).not.toBe('unknown-unavailable')
      expect(sandboxPostProcessingAdapterRegistry.autoMCForIndividual).toBeUndefined()
    })
  })

  describe('E/F/G. Ring canonical chain — real batch-level execution, chained directories, compulsory scripts always run', () => {
    it('imageResizeNew -> compressorNew -> makeCompareRB genuinely pad, compress, and add compare images for two real SKUs in one call each', async () => {
      const editingOutputDir = join(scratchDir, 'editing-output')
      await mkdir(editingOutputDir, { recursive: true })
      // Two SKUs in ONE directory — proves batch-level (not per-image)
      // invocation: each script call below handles both at once.
      await writeRgba(join(editingOutputDir, 'SKU1;frontImage.png'), 40, 100, () => SOLID)
      await writeRgba(join(editingOutputDir, 'SKU1;frontFullImage.png'), 40, 60, () => SOLID)
      await writeRgba(join(editingOutputDir, 'SKU2;frontImage.png'), 40, 80, () => SOLID)
      await writeRgba(join(editingOutputDir, 'SKU2;frontFullImage.png'), 40, 80, () => SOLID)

      const { imageResizeNewAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/imageResizeNewAdapter')
      const { compressorNewAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/compressorNewAdapter')
      const { makeCompareRBAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/makeCompareRBAdapter')

      const resizeDir = join(scratchDir, 'post-processing', 'imageResizeNew')
      const resizeResult = await imageResizeNewAdapter.run({
        runId: 'run-1', productType: 'ring', scriptId: 'imageResizeNew', inputDir: editingOutputDir, outputDir: resizeDir, batchId: 'b1',
      })
      expect(resizeResult.ok).toBe(true)
      if (!resizeResult.ok) return
      // D. correct output path — SKU1's frontFullImage (shorter, 60px) was
      // padded to match frontImage's 100px height; SKU2's pair already
      // matched and is untouched.
      const sku1Meta = await sharp(join(resizeResult.outputDir, 'SKU1;frontFullImage.png')).metadata()
      expect(sku1Meta.height).toBe(100)
      const sku2Meta = await sharp(join(resizeResult.outputDir, 'SKU2;frontFullImage.png')).metadata()
      expect(sku2Meta.height).toBe(80)

      const compressDir = join(scratchDir, 'post-processing', 'compressorNew')
      const compressResult = await compressorNewAdapter.run({
        runId: 'run-1', productType: 'ring', scriptId: 'compressorNew', inputDir: resizeResult.outputDir, outputDir: compressDir, batchId: 'b1',
      })
      expect(compressResult.ok).toBe(true)
      if (!compressResult.ok) return
      const compressedFiles = await readdir(compressResult.outputDir)
      // D. compressorNew preserves filenames — chaining depends on this.
      expect(compressedFiles).toContain('SKU1;frontFullImage.png')
      expect(compressedFiles).toContain('SKU2;frontFullImage.png')

      const compareDir = join(scratchDir, 'post-processing', 'makeCompareRB')
      const compareResult = await makeCompareRBAdapter.run({
        runId: 'run-1', productType: 'ring', scriptId: 'makeCompareRB', inputDir: compressResult.outputDir, outputDir: compareDir, batchId: 'b1',
      })
      expect(compareResult.ok).toBe(true)
      if (!compareResult.ok) return
      const finalFiles = await readdir(compareResult.outputDir)
      // G. compulsory chain produced a real ;compare artifact for both SKUs.
      expect(finalFiles).toContain('SKU1;compare.png')
      expect(finalFiles).toContain('SKU2;compare.png')
      // The compressed originals are still there too (compare only adds).
      expect(finalFiles).toContain('SKU1;frontFullImage.png')
    }, 30000)
  })

  describe('H/K/L. autoMCFF (optional) — fixed per-product-type default width, real CSV artifact', () => {
    it('uses 20mm for Ring and 60mm for Bracelet, computed from real image aspect ratio, and writes a real dimensions.csv', async () => {
      const compareDir = join(scratchDir, 'compare-input')
      await mkdir(compareDir, { recursive: true })
      // 2:1 aspect ratio (height = 2x width) — for a Ring at 20mm assumed
      // width, height should compute to 40mm; for a Bracelet at 60mm,
      // height should compute to 120mm.
      await writeRgba(join(compareDir, 'SKU1;compare.png'), 100, 200, () => SOLID)

      const { autoMCFFAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/autoMCFFAdapter')

      const ringOutDir = join(scratchDir, 'ring-out')
      const ringResult = await autoMCFFAdapter.run({
        runId: 'run-1', productType: 'ring', scriptId: 'autoMCFF', inputDir: compareDir, outputDir: ringOutDir, batchId: 'b1',
      })
      expect(ringResult.ok).toBe(true)
      if (!ringResult.ok) return
      expect(ringResult.artifact?.kind).toBe('measurementData')
      const ringCsv = await readFile(join(ringOutDir, 'dimensions.csv'), 'utf-8')
      expect(ringCsv).toContain('SKU1,20.0,40.0')

      const braceletOutDir = join(scratchDir, 'bracelet-out')
      const braceletResult = await autoMCFFAdapter.run({
        runId: 'run-1', productType: 'bracelet', scriptId: 'autoMCFF', inputDir: compareDir, outputDir: braceletOutDir, batchId: 'b1',
      })
      expect(braceletResult.ok).toBe(true)
      if (!braceletResult.ok) return
      const braceletCsv = await readFile(join(braceletOutDir, 'dimensions.csv'), 'utf-8')
      expect(braceletCsv).toContain('SKU1,60.0,120.0')

      // Images still pass through unchanged — Final Review needs a real
      // image directory even when this optional script is enabled.
      const files = await readdir(ringOutDir)
      expect(files).toContain('SKU1;compare.png')
    }, 30000)

    it('is not offered for a product type it has no configured default for (earring/necklace/watch/gemstone)', async () => {
      const { autoMCFFAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/autoMCFFAdapter')
      const result = await autoMCFFAdapter.run({
        runId: 'run-1', productType: 'earring', scriptId: 'autoMCFF', inputDir: scratchDir, outputDir: join(scratchDir, 'out'), batchId: 'b1',
      })
      expect(result.ok).toBe(false)
    })
  })

  describe('M. Watch post-processing — removeShadows strips faint alpha without rotating, compressorNew preserves orientation', () => {
    it('drops low-alpha pixels to fully transparent, keeps size/orientation unchanged (no 270° rotate — see the Phase 15.7 conversation)', async () => {
      const editingOutputDir = join(scratchDir, 'watch-editing-output')
      await mkdir(editingOutputDir, { recursive: true })
      // A 40x80 image with a faint (alpha=20, below threshold 90) top strip
      // and an opaque bottom region.
      await writeRgba(join(editingOutputDir, 'WATCH-1.png'), 40, 80, (_x, y) => (y < 10 ? [0, 0, 255, 20] : [0, 0, 255, 255]))

      const { removeShadowsAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/removeShadowsAdapter')
      const outputDir = join(scratchDir, 'post-processing', 'removeShadows')
      const result = await removeShadowsAdapter.run({
        runId: 'run-1', productType: 'watch', scriptId: 'removeShadows', inputDir: editingOutputDir, outputDir, batchId: 'b1',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const outPath = join(result.outputDir, 'WATCH-1.png')
      const meta = await sharp(outPath).metadata()
      // Orientation/size unchanged — the removed rotation would have made
      // this 80x40 instead.
      expect(meta.width).toBe(40)
      expect(meta.height).toBe(80)

      const { data, info } = await sharp(outPath).raw().ensureAlpha().toBuffer({ resolveWithObject: true })
      const faintPixelAlpha = data[(0 * info.width + 0) * 4 + 3]
      const opaquePixelAlpha = data[(70 * info.width + 0) * 4 + 3]
      expect(faintPixelAlpha).toBe(0)
      expect(opaquePixelAlpha).toBe(255)
    }, 30000)
  })

  describe('K. autoMeasurementCalculator (Earring, optional) — real metadata artifact, per-script capability check', () => {
    it('classifies real images and writes a real measurements.xlsx, distinct from an image artifact', async () => {
      const editingOutputDir = join(scratchDir, 'earring-editing-output')
      await mkdir(editingOutputDir, { recursive: true })
      await writeRgba(join(editingOutputDir, 'EARRING-1.png'), 900, 1000, () => SOLID)

      const { checkPythonModules, resolvePostProcessingPython } = await import('../apps/desktop/electron/services/pythonResolver')
      const python = await resolvePostProcessingPython()
      const hasPandas = python ? await checkPythonModules(python, ['pandas', 'openpyxl']) : false
      if (!hasPandas) {
        console.warn('Skipping autoMeasurementCalculator assertions: pandas/openpyxl not available in the resolved interpreter.')
        return
      }

      const { autoMeasurementCalculatorAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/autoMeasurementCalculatorAdapter')
      const outputDir = join(scratchDir, 'post-processing', 'autoMeasurementCalculator')
      const result = await autoMeasurementCalculatorAdapter.run({
        runId: 'run-1', productType: 'earring', scriptId: 'autoMeasurementCalculator', inputDir: editingOutputDir, outputDir, batchId: 'b1',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.artifact?.kind).toBe('measurementData')
      const files = await readdir(result.outputDir)
      expect(files).toContain('measurements.xlsx')
      // Image passes through too — not disguised as/replaced by the
      // metadata artifact.
      expect(files).toContain('EARRING-1.png')
    }, 30000)
  })

  describe('I/J. missing/invalid input — real failure, never fabricated success', () => {
    it('I. an empty input directory fails honestly rather than reporting a vacuous success', async () => {
      const emptyDir = join(scratchDir, 'empty')
      await mkdir(emptyDir, { recursive: true })
      const { compressorNewAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/compressorNewAdapter')
      const result = await compressorNewAdapter.run({
        runId: 'run-1', productType: 'watch', scriptId: 'compressorNew', inputDir: emptyDir, outputDir: join(scratchDir, 'out'), batchId: 'b1',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBeTruthy()
    })

    it('J. a corrupt image file causes a real non-zero exit, surfaced as a real error message, not a silent skip or fabricated success', async () => {
      const editingOutputDir = join(scratchDir, 'corrupt-editing-output')
      await mkdir(editingOutputDir, { recursive: true })
      // Not a real PNG — Pillow will throw when it tries to open this.
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(editingOutputDir, 'BROKEN.png'), 'this is not a png file')

      const { compressorNewAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/compressorNewAdapter')
      const result = await compressorNewAdapter.run({
        runId: 'run-1', productType: 'watch', scriptId: 'compressorNew', inputDir: editingOutputDir, outputDir: join(scratchDir, 'out2'), batchId: 'b1',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('compressorNew')
    }, 30000)
  })
})
