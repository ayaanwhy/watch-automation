// Gemstone pipeline, end to end with REAL execution: Editing trims to the
// canonical `SKU;compare.png` -> real resizeGems subprocess (headless wrapper
// of the untouched post-scripts/resizeGems.py) duplicates it into
// `SKU;frontImage.png` -> compressorNew -> Final Review resolves ;frontImage. Shape/width/height are explicit required
// inputs — never defaulted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, stat, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

let scratchDir: string
const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir, getAppPath: () => REAL_APP_PATH },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}))

// Opaque ellipse (bw x bh) centred on a larger TRANSPARENT canvas, so the
// forced Gemstone trim has real work to do and the trimmed size is known.
async function gemImage(path: string, bw: number, bh: number, pad = 40) {
  const w = bw + pad * 2, h = bh + pad * 2
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot((x - w / 2) / (bw / 2), (y - h / 2) / (bh / 2))
    const i = (y * w + x) * 4
    buf[i] = 90; buf[i + 1] = 30; buf[i + 2] = 200; buf[i + 3] = d <= 1 ? 255 : 0
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path)
}

async function waitTerminal(engine: any, id: string, extra: (s: any) => boolean = () => true) {
  const start = Date.now()
  while (Date.now() - start < 90000) {
    const s = await engine.getJobState(id)
    if (s && ['completed', 'partially_completed', 'failed', 'cancelled'].includes(s.status) && extra(s)) return s
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('timed out')
}

describe('Gemstone pipeline', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-gemstone-'))
    await mkdir(join(scratchDir, 'fx'), { recursive: true })
    vi.resetModules()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(scratchDir, { recursive: true, force: true })
  })

  it(
    'INPUT -> preprocessing -> Editing trims to ;compare -> resizeGems duplicates it into ;frontImage -> Final Review shows ;frontImage with ;compare as the reference',
    async () => {
      const p = (n: string) => join(scratchDir, 'fx', n)
      await gemImage(p('ok.png'), 200, 100)      // landscape stone
      await gemImage(p('pear.png'), 200, 100)    // landscape image, Pear shape
      await gemImage(p('noshape.png'), 120, 120)
      await gemImage(p('baddim.png'), 120, 120)
      const batch = {
        id: 'gem-batch', name: 'Gems', productTypes: ['gemstone'], imageCount: 4,
        images: [
          { sku: 'G-OK', imagePath: p('ok.png'), productType: 'gemstone', widthMm: 8, heightMm: 4, shape: 'Round' },
          { sku: 'G-PEAR', imagePath: p('pear.png'), productType: 'gemstone', widthMm: 6, heightMm: 9, shape: 'Pear Brilliant' },
          { sku: 'G-NOSHAPE', imagePath: p('noshape.png'), productType: 'gemstone', widthMm: 5, heightMm: 5 },
          { sku: 'G-BADDIM', imagePath: p('baddim.png'), productType: 'gemstone', widthMm: -2, heightMm: 5, shape: 'Round' },
        ],
      } as any

      const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
      const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
      const config = createInitialUniversalConfig(batch)
      config.preprocessing.operation = 'none' // no upscale/bg-removal: preprocessing output is the (padded) source

      const submitted = await automationEngine.submitJob(batch, config)
      expect(submitted.ok).toBe(true)
      const run = await waitTerminal(automationEngine, submitted.runId!)

      expect(run.status).toBe('partially_completed')
      const items = Object.fromEntries(run.items.map((i: any) => [i.sku, i]))
      // Missing Shape / invalid dimensions: precise, actionable, non-retryable, and never guessed around.
      expect(items['G-NOSHAPE']).toMatchObject({ status: 'failed', failure: { code: 'MISSING_GEMSTONE_SHAPE', retryable: false, stage: 'input' } })
      expect(items['G-NOSHAPE'].failure.action).toMatch(/Shape/)
      expect(items['G-BADDIM']).toMatchObject({ status: 'failed', failure: { code: 'INVALID_GEMSTONE_DIMENSIONS', retryable: false } })
      for (const sku of ['G-OK', 'G-PEAR']) {
        expect(items[sku].status).toBe('completed')
        expect(items[sku].stages.map((s: any) => [s.label, s.status])).toEqual([
          ['Trim & Save Compare', 'done'], ['resizeGems', 'done'], ['compressorNew', 'done'],
        ])
      }

      const pipeline = run.pipelines[0]
      expect(pipeline.status).toBe('completed')
      const finalDir = pipeline.postProcessingOutputDir as string
      expect(existsSync(finalDir)).toBe(true)
      // Only valid stones have artifacts; BOTH ;compare and ;frontImage exist for each.
      expect((await readdir(finalDir)).sort()).toEqual(['G-OK;compare.png', 'G-OK;frontImage.png', 'G-PEAR;compare.png', 'G-PEAR;frontImage.png'])

      const ws = join(scratchDir, 'sandbox-runs', run.id, 'workspace', 'gemstone')
      const editingOut = join(ws, 'editing-output')

      // Preprocessing produced the Editing input: the (padded, untrimmed) source canvas.
      const pre = await sharp(join(ws, 'preprocessed', 'G-OK.png')).metadata()
      expect(pre.width).toBe(280)
      expect(pre.height).toBe(180)
      // Editing consumed it and saved the TRIMMED image as ;compare (bounding box ≈ the stone).
      const compare = await sharp(join(editingOut, 'G-OK;compare.png')).metadata()
      expect(Math.abs(compare.width! - 200)).toBeLessThanOrEqual(3)
      expect(Math.abs(compare.height! - 100)).toBeLessThanOrEqual(3)
      // Editing output is ONLY the reference — resizeGems, not Editing, produces the front image.
      expect((await readdir(editingOut)).sort()).toEqual(['G-OK;compare.png', 'G-PEAR;compare.png'])

      // resizeGems consumed ;compare and left it unchanged: its copy is byte-identical to the Editing artifact.
      const resizeOut = join(ws, 'post-processing', 'resizeGems')
      const editingBytes = await readFile(join(editingOut, 'G-OK;compare.png'))
      expect((await readFile(join(resizeOut, 'G-OK;compare.png'))).equals(editingBytes)).toBe(true)

      // ;frontImage is an independent, genuinely transformed file (2000px canvas @ 100px/mm).
      const front = await sharp(join(finalDir, 'G-OK;frontImage.png')).metadata()
      expect(front.width).toBe(2000)
      expect(Math.abs(front.height! - 400)).toBeLessThanOrEqual(6) // 8mm wide -> 800px stone, height scaled ≈ 400
      expect(front.width).not.toBe(compare.width)
      const pear = await sharp(join(finalDir, 'G-PEAR;frontImage.png')).metadata()
      expect(pear.width).toBe(2000)
      expect(Math.abs(pear.height! - 1800)).toBeLessThanOrEqual(12) // force-rotated, sized from Height 9mm
      // The compare in the final dir is still the trimmed reference size, not the canvas.
      const finalCompare = await sharp(join(finalDir, 'G-OK;compare.png')).metadata()
      expect(finalCompare.width).toBe(compare.width)
      expect(finalCompare.height).toBe(compare.height)
      // The stone is centred horizontally on the transparent canvas.
      const { data, info } = await sharp(join(finalDir, 'G-OK;frontImage.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const midRow = Math.floor(info.height / 2)
      let first = -1, lastX = -1
      for (let x = 0; x < info.width; x++) if (data[(midRow * info.width + x) * 4 + 3] > 0) { if (first < 0) first = x; lastX = x }
      expect(Math.abs(first + lastX - (info.width - 1))).toBeLessThanOrEqual(24)

      // Final Review: the FINAL artifact is ;frontImage; ;compare is the before/reference — never shown as the final output.
      const { sandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
      vi.spyOn(sandboxApiClient, 'getTemporaryBatchDetail').mockResolvedValue(batch)
      const { getSandboxReviewItems, approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
      const { isItemReviewable } = await import('../apps/desktop/src/sandbox/lib/sandboxReviewData')
      const review = (await getSandboxReviewItems(run.id))!
      const reviewOk = review.find(r => r.sku === 'G-OK')!
      expect(reviewOk.outputPath).toBe(join(finalDir, 'G-OK;frontImage.png'))
      expect(reviewOk.compareOutputPath).toBe(join(finalDir, 'G-OK;compare.png'))
      expect(reviewOk.outputPath).not.toBe(reviewOk.compareOutputPath)
      expect(reviewOk.measurement).toMatchObject({ kind: 'gemstone', shape: 'Round', widthMm: 8, heightMm: 4 })
      expect(isItemReviewable(reviewOk)).toBe(true)
      for (const sku of ['G-NOSHAPE', 'G-BADDIM']) expect(isItemReviewable(review.find(r => r.sku === sku)!)).toBe(false)
      const refused = await approveSandboxItems(run.id, [{ productType: 'gemstone', sku: 'G-NOSHAPE' }])
      expect(refused.ok).toBe(false)
    },
    120000,
  )

  it(
    'a failure at resizeGems leaves ;compare intact, and retrying post-processing reuses it — preprocessing and Editing are NOT rerun',
    async () => {
      const p = (n: string) => join(scratchDir, 'fx', n)
      await gemImage(p('a.png'), 160, 100)
      const batch = {
        id: 'gem-retry', name: 'Gems', productTypes: ['gemstone'], imageCount: 1,
        images: [{ sku: 'G-A', imagePath: p('a.png'), productType: 'gemstone', widthMm: 8, heightMm: 5, shape: 'Round' }],
      } as any

      // A project root whose resizeGems exits non-zero; every other script is the real one.
      const realRoot = join(REAL_APP_PATH, '..', '..')
      const fakeRoot = join(scratchDir, 'fake-root')
      await mkdir(join(fakeRoot, 'postProcessing', 'resizeGems'), { recursive: true })
      for (const d of await readdir(join(realRoot, 'postProcessing'))) {
        if (d !== 'resizeGems') await symlink(join(realRoot, 'postProcessing', d), join(fakeRoot, 'postProcessing', d))
      }
      await writeFile(join(fakeRoot, 'postProcessing', 'resizeGems', 'runner.py'), 'import sys\nsys.stderr.write("boom")\nsys.exit(3)\n')
      const { configureEngineRuntime } = await import('../apps/desktop/electron/sandbox/engine/runtime')
      configureEngineRuntime({ projectRoot: () => fakeRoot })

      const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
      const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
      const config = createInitialUniversalConfig(batch)
      config.preprocessing.operation = 'none'
      const submitted = await automationEngine.submitJob(batch, config)
      expect(submitted.ok).toBe(true)
      const failedRun = await waitTerminal(automationEngine, submitted.runId!)
      const failedItem = failedRun.items[0]
      expect(failedItem).toMatchObject({ status: 'failed', failure: { code: 'POSTPROCESSING_NONZERO_EXIT', stageDetail: 'resizeGems', retryable: true } })

      // The reference survived the failure, untouched, in Editing's output.
      const runDir = join(scratchDir, 'sandbox-runs', failedRun.id)
      const editingCompare = join(runDir, 'workspace', 'gemstone', 'editing-output', 'G-A;compare.png')
      expect(existsSync(editingCompare)).toBe(true)
      const compareBefore = await readFile(editingCompare)
      const preprocessedMtime = (await stat(join(runDir, 'workspace', 'gemstone', 'preprocessed', 'G-A.png'))).mtimeMs

      // Fix the script (restore the real root) and retry that one image.
      configureEngineRuntime({ projectRoot: () => realRoot })
      const retry = await automationEngine.retryImage(failedRun.id, 'gemstone', 'G-A')
      expect(retry.ok).toBe(true)
      const done = await waitTerminal(automationEngine, failedRun.id, (s: any) => s.items[0].status === 'completed')
      expect(done.items[0]).toMatchObject({ status: 'completed', attempt: 2 })
      expect(done.items[0].history).toHaveLength(1)
      expect(done.items[0].history[0]).toMatchObject({ attempt: 1, restartedFrom: 'post_processing', failure: { code: 'POSTPROCESSING_NONZERO_EXIT' } })

      // Both artifacts now exist in the final dir; compare is still the unchanged reference.
      const finalDir = done.pipelines[0].postProcessingOutputDir as string
      expect((await readdir(finalDir)).sort()).toEqual(['G-A;compare.png', 'G-A;frontImage.png'])
      expect((await readFile(editingCompare)).equals(compareBefore)).toBe(true)
      expect((await stat(join(runDir, 'workspace', 'gemstone', 'preprocessed', 'G-A.png'))).mtimeMs).toBe(preprocessedMtime)
      // The retry workspace holds only post-processing work — no preprocessing/editing directories were recreated.
      const retryDirs = await readdir(join(runDir, 'retry'))
      expect(retryDirs).toHaveLength(1)
      const retryWs = join(runDir, 'retry', retryDirs[0])
      const retryLayout = await readdir(retryWs, { recursive: true } as any)
      expect(retryLayout.some(f => String(f).includes('preprocessed'))).toBe(false)
      const front = await sharp(join(finalDir, 'G-A;frontImage.png')).metadata()
      expect(front.width).toBe(2000)
    },
    120000,
  )

  describe('resizeGems adapter — real subprocess, real output verification', () => {
    async function runAdapter(input: string, rows: Record<string, any>, root?: string) {
      const { resizeGemsAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/resizeGemsAdapter')
      const { normalizeSandboxProductItem } = await import('../apps/desktop/src/sandbox/lib/normalizeSandboxProductData')
      if (root) (await import('../apps/desktop/electron/sandbox/engine/runtime')).configureEngineRuntime({ projectRoot: () => root })
      const items = Object.entries(rows).map(([sku, r]) => normalizeSandboxProductItem({ sku, imagePath: '/x.png', productType: 'gemstone', ...r }))
      return resizeGemsAdapter.run({ runId: 'r', productType: 'gemstone', scriptId: 'resizeGems', inputDir: input, outputDir: join(scratchDir, 'out'), batchId: 'b', items })
    }

    it('pear force-rotates and sizes from height; the "rotation check" rotates a non-pear only when px and mm long sides disagree', async () => {
      const dir = join(scratchDir, 'in')
      await mkdir(dir)
      await gemImage(join(dir, 'PEAR;compare.png'), 200, 100, 0)
      await gemImage(join(dir, 'CHECK;compare.png'), 200, 100, 0)   // landscape px
      await gemImage(join(dir, 'PLAIN;compare.png'), 200, 100, 0)   // landscape px, sheet agrees
      const result = await runAdapter(dir, {
        PEAR: { widthMm: 6, heightMm: 9, shape: 'Pear' },
        CHECK: { widthMm: 6, heightMm: 9, shape: 'Round' },   // sheet says taller than wide -> conditional rotate
        PLAIN: { widthMm: 9, heightMm: 6, shape: 'Round' },   // agrees -> untouched
      })
      expect(result.ok).toBe(true)
      const dims = async (n: string) => { const m = await sharp(join(scratchDir, 'out', `${n};frontImage.png`)).metadata(); return [m.width, m.height] }
      expect(await dims('PEAR')).toEqual([2000, 1800])   // rotated 100x200, width from Height 9mm
      expect(await dims('CHECK')).toEqual([2000, 1200])  // rotated 100x200, width 6mm -> scale 6
      expect(await dims('PLAIN')).toEqual([2000, 450])   // not rotated: 200x100 -> width 9mm=900 -> h 450
      // The compare is copied through byte-for-byte; the input is never modified.
      for (const n of ['PEAR', 'CHECK', 'PLAIN']) {
        expect((await readFile(join(scratchDir, 'out', `${n};compare.png`))).equals(await readFile(join(dir, `${n};compare.png`)))).toBe(true)
      }
    })

    it('never trusts the exit code alone: a script that claims success but wrote nothing is POSTPROCESSING_OUTPUT_MISSING, a non-image frontImage is OUTPUT_INVALID', async () => {
      const fakeRoot = join(scratchDir, 'fake-root')
      await mkdir(join(fakeRoot, 'postProcessing', 'resizeGems'), { recursive: true })
      const script = join(fakeRoot, 'postProcessing', 'resizeGems', 'runner.py')
      const claim = `import json;print('RESULT_JSON:'+json.dumps({'ok':True,'processed':[{'sku':'G1'}]}))`
      await writeFile(script, claim)
      const input = join(scratchDir, 'in2'); await mkdir(input)
      await gemImage(join(input, 'G1;compare.png'), 60, 60, 0)
      const missing = await runAdapter(input, { G1: { widthMm: 5, heightMm: 5, shape: 'Round' } }, fakeRoot)
      expect(missing).toMatchObject({ ok: false, failure: { code: 'POSTPROCESSING_OUTPUT_MISSING', stageDetail: 'resizeGems', retryable: true } })

      await writeFile(script, `import json,os,sys,shutil\nout=sys.argv[sys.argv.index('--output-dir')+1]\nos.makedirs(out,exist_ok=True)\nshutil.copyfile(os.path.join(sys.argv[sys.argv.index('--input-dir')+1],'G1;compare.png'),os.path.join(out,'G1;compare.png'));open(os.path.join(out,'G1;frontImage.png'),'w').write('not an image')\nprint('RESULT_JSON:'+json.dumps({'ok':True,'processed':[{'sku':'G1'}]}))`)
      const invalid = await runAdapter(input, { G1: { widthMm: 5, heightMm: 5, shape: 'Round' } }, fakeRoot)
      expect(invalid).toMatchObject({ ok: false, failure: { code: 'POSTPROCESSING_OUTPUT_INVALID' } })
    })

    it('with no item carrying width, height AND Shape, resizeGems reports the capability as unavailable rather than running', async () => {
      const dir = join(scratchDir, 'in3'); await mkdir(dir)
      const result = await runAdapter(dir, { G1: { widthMm: 5, heightMm: 5 } })
      expect(result).toMatchObject({ ok: false, unavailable: true, failure: { code: 'POSTPROCESSING_CAPABILITY_UNAVAILABLE' } })
    })

    it('a script that processes nothing (no matching image) fails as a non-zero exit, not a silent success', async () => {
      const dir = join(scratchDir, 'in4'); await mkdir(dir)
      await gemImage(join(dir, 'OTHER.png'), 60, 60, 0) // not a ;compare — must be ignored
      const result = await runAdapter(dir, { G1: { widthMm: 5, heightMm: 5, shape: 'Round' } })
      expect(result).toMatchObject({ ok: false, failure: { code: 'POSTPROCESSING_NONZERO_EXIT' } })
    })
  })
})
