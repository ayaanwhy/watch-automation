// Ring segmentation (PixelForge-derived ONNX model), against OUR contract, with
// REAL execution: the real Ring & Bracelet runner, the real model, real Python.
//
//   preprocessing output (already background-removed)
//     ├─ frontFullImage = that image, unmodified
//     └─ Ring model -> rear-band ownership -> frontImage (then the unchanged shadow step)
//
// Real-photo cases use two actual background-removed ring images (production
// preprocessing output) kept in sampledata/ — like the repo's other real
// sample (sampledata/1688KM11.png), git-ignored, so those cases are skipped
// where the files are absent. Model-failure paths use fault injection (a
// broken model directory, a missing runtime, a monkeypatched inference) since
// the real model cannot be made to fail on demand.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, mkdir, writeFile, copyFile, readdir, readFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
// Real-photo cases need the git-ignored samples in sampledata/ (see the header); they are reported as skipped, never silently passed.
const itReal = (it as any).skipIf(!existsSync(join(__dirname, '..', 'sampledata', 'ring-real-heart-band.png'))) as typeof it
const ROOT = join(__dirname, '..')
const RUNNER = join(ROOT, 'preprocessing', 'RingBracelet', 'runner.py')
const RING_SEG_DIR = join(ROOT, 'preprocessing', 'RingBracelet', 'ring_segmentation')
const REAL_RINGS = [
  { sku: 'HEART-BAND', path: join(ROOT, 'sampledata', 'ring-real-heart-band.png') },
  { sku: 'OVAL-SOLITAIRE', path: join(ROOT, 'sampledata', 'ring-real-oval-solitaire.png') },
].filter(r => existsSync(r.path))

let scratchDir: string
let PYTHON: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir, getAppPath: () => join(__dirname, '..', 'apps', 'desktop') },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}))

interface RunResult {
  events: Record<string, any>[]
  exitCode: number
  stderr: string
}

async function runRunner(product: 'ring' | 'bracelet', inputDir: string, outputDir: string, opts: { mode?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(PYTHON, [RUNNER, '--input-dir', inputDir, '--output-dir', outputDir, '--product', product, '--processing-mode', opts.mode ?? 'automatic'], {
      env: { ...process.env, ...opts.env },
      maxBuffer: 64 * 1024 * 1024,
    })
    return { events: parseEvents(stdout), exitCode: 0, stderr }
  } catch (err: any) {
    return { events: parseEvents(err.stdout ?? ''), exitCode: err.code ?? 1, stderr: err.stderr ?? '' }
  }
}

const parseEvents = (stdout: string) => stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))

async function rgba(path: string) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

const opaqueCount = (img: { data: Buffer }, threshold = 250) => {
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= threshold) n++
  return n
}

async function stageInput(sku: string, source: string): Promise<{ inputDir: string; source: string }> {
  const inputDir = join(scratchDir, `in-${sku}`)
  await mkdir(inputDir, { recursive: true })
  await copyFile(source, join(inputDir, `${sku}.png`))
  return { inputDir, source }
}

// Runs a Python snippet with the ring_segmentation modules importable; the
// snippet prints one JSON line.
async function py(snippet: string, env: Record<string, string> = {}): Promise<any> {
  const script = join(scratchDir, `snippet-${Math.random().toString(36).slice(2)}.py`)
  await writeFile(script, `import sys, json\nsys.path.insert(0, ${JSON.stringify(RING_SEG_DIR)})\n${snippet}\n`)
  const { stdout } = await execFileAsync(PYTHON, [script], { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout.trim().split('\n').at(-1)!)
}

describe('Ring segmentation model — real runner, real model', () => {
  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-ringseg-boot-'))
    const { resolvePreprocessingPython } = await import('../apps/desktop/electron/services/pythonResolver')
    const resolved = await resolvePreprocessingPython()
    if (!resolved) throw new Error('No Python interpreter resolved — the ring model tests need the project Python environment')
    PYTHON = resolved
    // The two ONNX files are git-ignored: install them from the checked-in PixelForge release (hash-verified).
    await execFileAsync(PYTHON, [join(RING_SEG_DIR, 'install_models.py')])
  }, 120000)
  afterAll(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-ringseg-'))
    vi.resetModules()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(scratchDir, { recursive: true, force: true })
  })

  describe.each(REAL_RINGS)('real background-removed ring: $sku', ({ sku, path }) => {
    it(
      'Ring: preprocessing output stays frontFullImage untouched; frontImage is the model-segmented front (rear band removed), on the pipeline\'s own naming/layout',
      async () => {
        const { inputDir } = await stageInput(sku, path)
        const out = join(scratchDir, 'out')
        const manualOut = join(scratchDir, 'out-manual')
        const ring = await runRunner('ring', inputDir, out)
        const manual = await runRunner('ring', inputDir, manualOut, { mode: 'manual' }) // shadow only: the "no segmentation" baseline
        expect(ring.exitCode).toBe(0)
        expect(manual.exitCode).toBe(0)

        // Naming/location: exactly our two artifacts, nothing PixelForge-specific.
        expect((await readdir(out)).sort()).toEqual([`${sku};frontFullImage.png`, `${sku};frontImage.png`])

        // frontFullImage = the preprocessing artifact: same dimensions, identical pixels (incl. transparency).
        const input = await rgba(path)
        const full = await rgba(join(out, `${sku};frontFullImage.png`))
        expect([full.width, full.height]).toEqual([input.width, input.height])
        expect(full.data.equals(input.data)).toBe(true)

        // frontImage: segmented. Same output geometry as the un-segmented baseline (only the shadow step's canvas), ...
        const front = await rgba(join(out, `${sku};frontImage.png`))
        const baseline = await rgba(join(manualOut, `${sku};frontImage.png`))
        expect([front.width, front.height]).toEqual([baseline.width, baseline.height])
        // ... transparency preserved (an opaque-only image would fail this), ...
        expect(opaqueCount(front)).toBeGreaterThan(0)
        let transparent = 0
        for (let i = 3; i < front.data.length; i += 4) if (front.data[i] === 0) transparent++
        expect(transparent).toBeGreaterThan(front.width * front.height * 0.02)
        // ... the rear band was actually removed (a real, plausible share of the ring — never everything, never nothing), ...
        const before = opaqueCount(baseline)
        const after = opaqueCount(front)
        expect(after).toBeLessThan(before * 0.99)
        expect(after).toBeGreaterThan(before * 0.6)
        // ... and it only ever REMOVED alpha from the ring (never added any) — the "front" is carved out of our own silhouette.
        let added = 0
        for (let i = 3; i < front.data.length; i += 4) if (baseline.data[i] >= 250 && front.data[i] > baseline.data[i] + 1) added++
        expect(added).toBe(0)

        // Structured progress: Ring Segmentation, then the shadow/editing step, then complete; ownership found confidently.
        const kinds = ring.events.filter(e => e.image === `${sku}.png`).map(e => (e.type === 'progress' ? `${e.type}:${e.stage}` : e.type))
        expect(kinds).toEqual(['progress:ring_segmentation', 'progress:shadow', 'complete'])
        expect(ring.events.find(e => e.type === 'complete')!.detected).toBe(true)
        expect(ring.events.at(-1)).toMatchObject({ type: 'done', succeeded: 1, failed: 0 })
      },
      180000,
    )
  })

  itReal('Bracelet still uses the ORIGINAL CV segmentation: output equals the shank_mask + shadow result, and the Ring model is never imported', async () => {
    const { inputDir } = await stageInput('BRAC', REAL_RINGS[0].path)
    const out = join(scratchDir, 'out')
    // Poison the ring model in every way it could be reached: no model dir, and an
    // `onnxruntime` that explodes on import. A bracelet must still succeed.
    const poison = join(scratchDir, 'poison')
    await mkdir(poison)
    await writeFile(join(poison, 'onnxruntime.py'), 'raise ImportError("onnxruntime must not be imported for bracelets")\n')
    const bracelet = await runRunner('bracelet', inputDir, out, { env: { RING_SEGMENTATION_MODEL_DIR: join(scratchDir, 'nope'), PYTHONPATH: poison } })
    expect(bracelet.exitCode).toBe(0)
    expect(bracelet.events.filter(e => e.type === 'progress').map(e => e.stage)).toEqual(['shank_mask']) // the CV stage, not ring_segmentation
    expect(bracelet.events.at(-1)).toMatchObject({ type: 'done', succeeded: 1, failed: 0 })

    // Independent expectation from the original CV modules (shank_mask + shadow, exactly the runner's pre-change bracelet path).
    const expected = await py(`
import numpy as np
from PIL import Image
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'preprocessing', 'RingBracelet'))})
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'preprocessing'))})
from shank_mask import generate_wrap_mask
from shadow import composite_with_shadow, RING_BRACELET_SHADOW
arr = np.array(Image.open(${JSON.stringify(join(inputDir, 'BRAC.png'))}).convert('RGBA'))
mask, _ = generate_wrap_mask(arr[:, :, 3], split_y=0.5)
a = np.clip(arr[:, :, 3].astype(np.float32) * (1.0 - mask.astype(np.float32) / 255.0), 0, 255).astype(np.uint8)
arr[:, :, 3] = a
res = np.array(composite_with_shadow(Image.fromarray(arr), RING_BRACELET_SHADOW).convert('RGBA'))
res.tofile(${JSON.stringify(join(scratchDir, 'expected.raw'))})
print(json.dumps({'w': res.shape[1], 'h': res.shape[0]}))
`)
    const actual = await rgba(join(out, 'BRAC;frontImage.png'))
    expect([actual.width, actual.height]).toEqual([expected.w, expected.h])
    expect(actual.data.equals(await readFile(join(scratchDir, 'expected.raw')))).toBe(true)
  }, 180000)

  itReal('the Ring path loads onnxruntime + the model but NO background-removal stack (torch / rembg / transformers / sam2 / basicsr) — PixelForge has none and preprocessing already ran ours', async () => {
    const { inputDir } = await stageInput('BG', REAL_RINGS[0].path)
    const modules = await py(`
import runpy, io, contextlib
sys.argv = ['runner.py', '--input-dir', ${JSON.stringify(inputDir)}, '--output-dir', ${JSON.stringify(join(scratchDir, 'out'))}, '--product', 'ring']
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        runpy.run_path(${JSON.stringify(RUNNER)}, run_name='__main__')
except SystemExit as e:
    code = e.code
loaded = sorted(m.split('.')[0] for m in sys.modules)
files = sorted({getattr(m, '__file__', '') or '' for m in sys.modules.values()})
print(json.dumps({'loaded': sorted(set(loaded)), 'pixelForgeFile': [f for f in files if 'pixelForge' in f]}))
`)
    expect(modules.loaded).toContain('onnxruntime')
    for (const forbidden of ['torch', 'rembg', 'transformers', 'sam2', 'basicsr', 'fastapi', 'uvicorn']) expect(modules.loaded, forbidden).not.toContain(forbidden)
    // Nothing is loaded from the coworker's /pixelForge checkout at runtime.
    expect(modules.pixelForgeFile).toEqual([])
  }, 180000)

  it('resolves its model assets from its own models/ directory (or RING_SEGMENTATION_MODEL_DIR) — no developer-specific or /pixelForge paths in production code', async () => {
    const files = ['front_ownership.py', 'pixelforge_ring.py', 'pixelforge_post.py'].map(f => join(RING_SEG_DIR, f)).concat(RUNNER)
    for (const file of files) {
      const code = readFileSync(file, 'utf-8')
      // Executable code only — comments/docstrings may cite the origin project.
      const executable = code.split('\n').filter(l => !l.trim().startsWith('#')).join('\n').replace(/"""[\s\S]*?"""/g, '')
      expect(executable, file).not.toMatch(/\/Users\/|\/home\/|C:\\\\|miniconda/)
      expect(executable, file).not.toMatch(/['"][^'"\n]*pixelForge[^'"\n]*['"]/)
    }
    // Relocated models directory works (proves the resolution is configuration, not a fixed path).
    const relocated = join(scratchDir, 'relocated-models')
    await mkdir(relocated)
    for (const f of ['model.onnx', 'ownership_refiner.onnx']) await copyFile(join(RING_SEG_DIR, 'models', f), join(relocated, f))
    const { inputDir } = await stageInput('RELOC', REAL_RINGS[0]?.path ?? join(ROOT, 'sampledata', '1688KM11.png'))
    const result = await runRunner('ring', inputDir, join(scratchDir, 'out'), { env: { RING_SEGMENTATION_MODEL_DIR: relocated } })
    expect(result.exitCode).toBe(0)
  }, 180000)

  describe('failures are stable, structured tokens (never a bare traceback)', () => {
    const ringInput = () => join(ROOT, 'sampledata', REAL_RINGS.length ? 'ring-real-heart-band.png' : '1688KM11.png')

    it('missing / corrupt model files -> the whole job fails up front with [RING_SEGMENTATION_MODEL_UNAVAILABLE]; no image output', async () => {
      const { inputDir } = await stageInput('M', ringInput())
      const missing = await runRunner('ring', inputDir, join(scratchDir, 'o1'), { env: { RING_SEGMENTATION_MODEL_DIR: join(scratchDir, 'nowhere') } })
      const fatal = missing.events.find(e => e.type === 'fatal')!
      expect(missing.exitCode).toBe(1)
      expect(fatal.error).toMatch(/^\[RING_SEGMENTATION_MODEL_UNAVAILABLE\] /)
      expect(fatal.error).toContain('install_models.py')
      expect(missing.events.some(e => e.type === 'complete')).toBe(false)

      const corrupt = join(scratchDir, 'corrupt')
      await mkdir(corrupt)
      await writeFile(join(corrupt, 'model.onnx'), 'not an onnx graph')
      await copyFile(join(RING_SEG_DIR, 'models', 'ownership_refiner.onnx'), join(corrupt, 'ownership_refiner.onnx'))
      const bad = await runRunner('ring', inputDir, join(scratchDir, 'o2'), { env: { RING_SEGMENTATION_MODEL_DIR: corrupt } })
      expect(bad.events.find(e => e.type === 'fatal')!.error).toMatch(/^\[RING_SEGMENTATION_MODEL_UNAVAILABLE\] /)
    }, 120000)

    it('a Python without onnxruntime -> [RING_SEGMENTATION_RUNTIME_ERROR]', async () => {
      const { inputDir } = await stageInput('R', ringInput())
      const poison = join(scratchDir, 'noort')
      await mkdir(poison)
      await writeFile(join(poison, 'onnxruntime.py'), 'raise ImportError("No module named onnxruntime")\n')
      const result = await runRunner('ring', inputDir, join(scratchDir, 'o'), { env: { PYTHONPATH: poison } })
      expect(result.events.find(e => e.type === 'fatal')!.error).toMatch(/^\[RING_SEGMENTATION_RUNTIME_ERROR\] /)
    }, 120000)

    it.each([
      ['inference raises', 'raise RuntimeError("ORT_FAIL: bad tensor")', 'INFERENCE_FAILED'],
      ['output has the wrong shape', 'return np.zeros((3, 3), np.float32), np.zeros((3, 3), np.float32), np.zeros((3, 3), np.float32)', 'OUTPUT_INVALID'],
      ['output contains NaN', 'a = np.full(bgr.shape[:2], np.nan, np.float32); return a, a, a', 'OUTPUT_INVALID'],
      ['the model finds no ring (empty matte)', 'z = np.zeros(bgr.shape[:2], np.float32); return z, z, z', 'OUTPUT_MISSING'],
    ])('%s -> [RING_SEGMENTATION_%s] with the detail kept after the token', async (_label, body, kind) => {
      const result = await py(`
import numpy as np, importlib
import pixelforge_ring
def fake(bgr):
    ${body}
pixelforge_ring.segment = fake
import front_ownership
img = np.zeros((60, 80, 4), np.uint8); img[10:50, 10:70] = (200, 160, 60, 255)
try:
    front_ownership.generate_ring_model_mask(img)
    print(json.dumps({'ok': True}))
except front_ownership.RingSegmentationError as e:
    print(json.dumps({'ok': False, 'kind': e.kind, 'text': str(e)}))
`)
      expect(result.ok).toBe(false)
      expect(result.kind).toBe(kind)
      expect(result.text.startsWith(`[RING_SEGMENTATION_${kind}] `)).toBe(true)
      expect(result.text).not.toContain('Traceback')
    }, 120000)

    it('an image with nothing visible, or a non-RGBA array, is refused with a structured error before the model runs', async () => {
      const result = await py(`
import numpy as np
import front_ownership
out = []
for label, img in [('empty', np.zeros((40, 40, 4), np.uint8)), ('rgb', np.zeros((40, 40, 3), np.uint8))]:
    try:
        front_ownership.generate_ring_model_mask(img)
        out.append([label, None])
    except front_ownership.RingSegmentationError as e:
        out.append([label, e.kind])
print(json.dumps(out))
`)
      expect(result).toEqual([['empty', 'OUTPUT_MISSING'], ['rgb', 'OUTPUT_INVALID']])
    }, 120000)
  })
})

describe('Ring segmentation through the Automation Engine — Retry Image', () => {
  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-ringseg-boot-'))
    const { resolvePreprocessingPython } = await import('../apps/desktop/electron/services/pythonResolver')
    PYTHON = (await resolvePreprocessingPython())!
    await execFileAsync(PYTHON, [join(RING_SEG_DIR, 'install_models.py')])
  }, 120000)
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-ringseg-engine-'))
    vi.resetModules()
  })
  afterEach(async () => {
    delete process.env['RING_SEGMENTATION_MODEL_DIR']
    vi.restoreAllMocks()
    await rm(scratchDir, { recursive: true, force: true })
  })

  const TERMINAL = ['completed', 'partially_completed', 'failed', 'cancelled']
  async function waitFor(engine: any, id: string, pred: (s: any) => boolean) {
    const start = Date.now()
    while (Date.now() - start < 120000) {
      const s = await engine.getJobState(id)
      if (s && pred(s)) return s
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('timed out')
  }
  const settled = (s: any) => TERMINAL.includes(s.status) && s.items.every((i: any) => !['queued', 'running'].includes(i.status))
  const item = (run: any, sku: string) => run.items.find((i: any) => i.sku === sku)

  itReal(
    'a Ring segmentation failure is a structured error at the Ring Segmentation stage (Bracelets in the same run are unaffected); Retry Image reruns ONLY the segmentation boundary and the result becomes reviewable',
    async () => {
      const source = REAL_RINGS[0].path
      await mkdir(join(scratchDir, 'fx'), { recursive: true })
      await copyFile(source, join(scratchDir, 'fx', 'ring.png'))
      await copyFile(source, join(scratchDir, 'fx', 'bracelet.png'))
      const batch = {
        id: 'rs', name: 'RS', productTypes: ['ring', 'bracelet'], imageCount: 2,
        images: [
          { sku: 'R-1', imagePath: join(scratchDir, 'fx', 'ring.png'), productType: 'ring' },
          { sku: 'B-1', imagePath: join(scratchDir, 'fx', 'bracelet.png'), productType: 'bracelet' },
        ],
      } as any

      // Break ONLY the ring model (a directory with no models). Real subprocesses inherit the environment.
      process.env['RING_SEGMENTATION_MODEL_DIR'] = join(scratchDir, 'no-models')
      const { automationEngine: engine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
      const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
      const config = createInitialUniversalConfig(batch)
      config.preprocessing.operation = 'none'
      const submitted = await engine.submitJob(batch, config)
      const first = await waitFor(engine, submitted.runId!, settled)

      // Ring: structured, at its own stage, retryable, with the fix in the action; the technical text stays secondary.
      expect(item(first, 'R-1')).toMatchObject({
        status: 'failed',
        failure: { code: 'RING_SEGMENTATION_MODEL_UNAVAILABLE', stage: 'editing', stageDetail: 'Ring Segmentation', retryable: true, productType: 'ring' },
      })
      expect(item(first, 'R-1').failure.action).toMatch(/install_models\.py/)
      expect(item(first, 'R-1').failure.message).not.toMatch(/Traceback|onnx/i)
      expect(item(first, 'R-1').stages.map((s: any) => [s.id, s.status]).filter(([id]: string[]) => ['ring_segmentation', 'editing'].includes(id))).toEqual([
        ['ring_segmentation', 'failed'],
        ['editing', 'pending'],
      ])
      // Bracelet: never touches the Ring model — completes normally, with the CV stage plan (no Ring Segmentation stage).
      expect(item(first, 'B-1').status).toBe('completed')
      expect(item(first, 'B-1').stages.some((s: any) => s.id === 'ring_segmentation')).toBe(false)
      expect(first.status).toBe('partially_completed')

      const runDir = join(scratchDir, 'sandbox-runs', first.id)
      const preprocessed = join(runDir, 'workspace', 'ring', 'preprocessed')
      const preBytes = await readFile(join(preprocessed, 'R-1.png'))
      const bracFinal = first.pipelines.find((p: any) => p.productType === 'bracelet').postProcessingOutputDir as string
      const bracBefore = await Promise.all(readdirSync(bracFinal).sort().map(async f => [f, (await readFile(join(bracFinal, f))).toString('base64')]))

      // Retry with the model still broken -> a NEW structured error, attempt 2, the first kept.
      expect((await engine.retryImage(first.id, 'ring', 'R-1')).ok).toBe(true)
      const again = await waitFor(engine, first.id, s => item(s, 'R-1').attempt === 2 && item(s, 'R-1').status === 'failed')
      expect(item(again, 'R-1')).toMatchObject({ failure: { code: 'RING_SEGMENTATION_MODEL_UNAVAILABLE', sku: 'R-1' } })
      expect(item(again, 'R-1').history[0]).toMatchObject({ attempt: 1, restartedFrom: 'editing', failure: { code: 'RING_SEGMENTATION_MODEL_UNAVAILABLE' } })
      await waitFor(engine, first.id, settled)

      // Fix the environment; Retry Image reruns from the editing boundary (Ring Segmentation) only.
      delete process.env['RING_SEGMENTATION_MODEL_DIR']
      expect((await engine.retryImage(first.id, 'ring', 'R-1')).ok).toBe(true)
      const done = await waitFor(engine, first.id, s => settled(s) && s.status === 'completed')
      expect(item(done, 'R-1')).toMatchObject({ status: 'completed', attempt: 3, failure: null })
      expect(item(done, 'R-1').history).toHaveLength(2)
      expect(item(done, 'R-1').history.at(-1).restartedFrom).toBe('editing')
      expect(item(done, 'R-1').stages.every((s: any) => s.status === 'done')).toBe(true)

      // Upstream work was not rerun (preprocessed artifact untouched); the retry workspace only reuses the existing preprocessing artifact; the Bracelet's artifacts are unchanged.
      expect((await readFile(join(preprocessed, 'R-1.png'))).equals(preBytes)).toBe(true)
      const retryLayout = (await readdir(join(runDir, 'retry'), { recursive: true })).map(String)
      expect(retryLayout.some(f => f.includes('source'))).toBe(false) // the image was not re-materialized from its origin
      // The retry workspace only holds a COPY of the existing preprocessing artifact as its input.
      const reused = retryLayout.filter(f => f.endsWith('R-1.png'))
      expect(reused).toHaveLength(1)
      expect((await readFile(join(runDir, 'retry', reused[0]))).equals(preBytes)).toBe(true)
      const bracAfter = await Promise.all(readdirSync(bracFinal).sort().map(async f => [f, (await readFile(join(bracFinal, f))).toString('base64')]))
      expect(bracAfter).toEqual(bracBefore)

      // The retried ring's artifacts obey the Ring contract and are reviewable in Final Review.
      const ringFinal = done.pipelines.find((p: any) => p.productType === 'ring').postProcessingOutputDir as string
      const files = readdirSync(ringFinal)
      expect(files.some(f => f.startsWith('R-1;frontImage'))).toBe(true)
      expect(files.some(f => f.startsWith('R-1;frontFullImage'))).toBe(true)
      const { sandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
      vi.spyOn(sandboxApiClient, 'getTemporaryBatchDetail').mockResolvedValue(batch)
      const { getSandboxReviewItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
      const { isItemReviewable } = await import('../apps/desktop/src/sandbox/lib/sandboxReviewData')
      const review = (await getSandboxReviewItems(first.id))!
      expect(isItemReviewable(review.find(r => r.sku === 'R-1')!)).toBe(true)
      expect(existsSync(review.find(r => r.sku === 'R-1')!.outputPath!)).toBe(true)
    },
    300000,
  )
})
