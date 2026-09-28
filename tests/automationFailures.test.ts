// Failure injection through the REAL engine/adapters: every failure becomes a
// precise, structured AutomationError at the right level (item / product /
// run), completed work is never relabelled, and retryable vs fix-required is
// correct. Where a failure needs an external service (Watch AI) only the
// network edge (fetch) is substituted — the classification under test is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

let scratchDir: string
const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')
const REAL_WATCH_IMAGE = join(__dirname, '..', 'sampledata', '1688KM11.png')

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir, getAppPath: () => REAL_APP_PATH },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}))

async function ring(path: string) {
  const w = 220, h = 160
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot((x - w / 2) / (w * 0.35), (y - h / 2) / (h * 0.35))
    const i = (y * w + x) * 4
    buf[i] = 180; buf[i + 1] = 150; buf[i + 2] = 80; buf[i + 3] = d > 0.6 && d < 1 ? 255 : 0
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path)
}

async function terminal(engine: any, id: string) {
  const start = Date.now()
  while (Date.now() - start < 90000) {
    const s = await engine.getJobState(id)
    if (s && ['completed', 'partially_completed', 'failed', 'cancelled'].includes(s.status)) return s
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('timed out')
}

describe('failure injection — real engine', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-failures-'))
    await mkdir(join(scratchDir, 'fx'), { recursive: true })
    vi.resetModules()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await rm(scratchDir, { recursive: true, force: true })
  })
  const fx = (n: string) => join(scratchDir, 'fx', n)

  it(
    'input failures are per image and precise: missing, corrupt, unsupported format, un-trimmable — the good sibling still completes and the run is partially_completed',
    async () => {
      await ring(fx('ok.png'))
      await writeFile(fx('corrupt.png'), 'this is definitely not a png')
      await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).tiff().toFile(fx('wrongformat.tif'))
      await sharp({ create: { width: 60, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(fx('empty.png'))
      const batch = {
        id: 'in', name: 'Inputs', productTypes: ['ring'], imageCount: 5,
        images: [
          { sku: 'R-OK', imagePath: fx('ok.png'), productType: 'ring' },
          { sku: 'R-CORRUPT', imagePath: fx('corrupt.png'), productType: 'ring' },
          { sku: 'R-TIF', imagePath: fx('wrongformat.tif'), productType: 'ring' },
          { sku: 'R-GONE', imagePath: fx('does-not-exist.png'), productType: 'ring' },
          { sku: 'R-EMPTY', imagePath: fx('empty.png'), productType: 'ring' },
        ],
      } as any
      const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
      const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
      const config = createInitialUniversalConfig(batch)
      config.preprocessing = { operation: 'none', upscaleFactor: 2, trim: true, rotate: 0, resizeToHeight: null }

      const run = await terminal(automationEngine, (await automationEngine.submitJob(batch, config)).runId!)
      const by = Object.fromEntries(run.items.map((i: any) => [i.sku, i]))
      expect(by['R-OK'].status).toBe('completed')
      expect(by['R-CORRUPT']).toMatchObject({ status: 'failed', failure: { code: 'SOURCE_IMAGE_UNREADABLE', retryable: false, stage: 'input' } })
      expect(by['R-TIF']).toMatchObject({ status: 'failed', failure: { code: 'SOURCE_IMAGE_UNSUPPORTED_FORMAT', retryable: false } })
      expect(by['R-GONE']).toMatchObject({ status: 'failed', failure: { code: 'SOURCE_IMAGE_MISSING', retryable: true } })
      expect(by['R-EMPTY']).toMatchObject({ status: 'failed', failure: { code: 'TRIM_FAILED', stage: 'preprocessing' } })
      for (const sku of ['R-CORRUPT', 'R-TIF', 'R-GONE', 'R-EMPTY']) {
        expect(by[sku].failure.sku).toBe(sku)
        expect(by[sku].failure.action).toBeTruthy()
        expect(by[sku].failure.message).not.toMatch(/Traceback|Error:/)
        expect(by[sku].error).toContain(by[sku].failure.message) // legacy string carries the same human message
      }
      expect(run.status).toBe('partially_completed')
      expect(run.pipelines[0].status).toBe('completed') // product finished; failures are per image
      expect(run.failure).toBeNull()
    },
    120000,
  )

  it('when EVERY image of every product fails, the run fails with the precise cause at run level (and pipeline level)', async () => {
    await writeFile(fx('bad1.png'), 'nope')
    await writeFile(fx('bad2.png'), 'nope too')
    const batch = { id: 'all', name: 'All bad', productTypes: ['ring'], imageCount: 2, images: [{ sku: 'A', imagePath: fx('bad1.png'), productType: 'ring' }, { sku: 'B', imagePath: fx('bad2.png'), productType: 'ring' }] } as any
    const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const config = createInitialUniversalConfig(batch)
    config.preprocessing.operation = 'none'
    const run = await terminal(automationEngine, (await automationEngine.submitJob(batch, config)).runId!)
    expect(run.status).toBe('failed')
    expect(run.pipelines[0]).toMatchObject({ status: 'failed', failure: { code: 'SOURCE_IMAGE_UNREADABLE', productType: 'ring' } })
    expect(run.failure).toMatchObject({ code: 'SOURCE_IMAGE_UNREADABLE' })
    expect(run.items.every((i: any) => i.status === 'failed' && i.failure)).toBe(true)
  }, 60000)

  it('workspace/storage failure is refused at preflight as WORKSPACE_CREATE_FAILED (retryable), creating nothing', async () => {
    const blocker = join(scratchDir, 'blocked')
    await writeFile(blocker, 'a file, not a directory')
    scratchDir = blocker
    await ring(join(tmpdir(), `wpa-ring-${process.pid}.png`))
    const batch = { id: 'w', name: 'W', productTypes: ['ring'], imageCount: 1, images: [{ sku: 'R', imagePath: join(tmpdir(), `wpa-ring-${process.pid}.png`), productType: 'ring' }] } as any
    const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const config = createInitialUniversalConfig(batch)
    config.preprocessing.operation = 'none'
    const result = await automationEngine.createJob(batch, config)
    expect(result.ok).toBe(false)
    expect(result.failure).toMatchObject({ code: 'WORKSPACE_CREATE_FAILED', stage: 'filesystem', retryable: true })
    expect(result.error).toContain('Preflight failed')
    await rm(join(tmpdir(), `wpa-ring-${process.pid}.png`), { force: true })
  }, 60000)

  describe('Watch AI detection — classified from structured signals, never from message text', () => {
    // The API's `message` is free text that MUST be ignored: these deliberately
    // contain misleading words for the other categories.
    const MISLEADING = 'timeout network unreachable HTTP 503 implausible malformed'
    const cases: [string, () => Promise<Response> | never, string, boolean][] = [
      ['network failure', () => { throw new TypeError('fetch failed') }, 'WATCH_BOUNDARY_UNAVAILABLE', true],
      ['timeout', () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) }, 'WATCH_BOUNDARY_TIMEOUT', true],
      ['HTTP failure', async () => new Response('oops', { status: 503 }), 'WATCH_BOUNDARY_HTTP_ERROR', true],
      ['success:false (misleading message)', async () => new Response(JSON.stringify({ success: false, message: MISLEADING, case_bbox: null, dial_bbox: null }), { status: 200 }), 'WATCH_BOUNDARY_REJECTED', false],
      ['no boundaries (success:true, null bbox)', async () => new Response(JSON.stringify({ success: true, message: MISLEADING, case_bbox: null, dial_bbox: null }), { status: 200 }), 'WATCH_BOUNDARY_REJECTED', false],
      ['implausible bbox', async () => new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [500, 0, 501, 10], dial_bbox: null }), { status: 200 }), 'WATCH_BOUNDARY_INVALID', false],
      ['malformed response', async () => new Response('<html>not json</html>', { status: 200 }), 'WATCH_BOUNDARY_MALFORMED_RESPONSE', true],
    ]
    it.each(cases)('%s', async (_label, respond, code, retryable) => {
      await mkdir(join(scratchDir, 'watch-in'), { recursive: true })
      await mkdir(join(scratchDir, 'watch-out'), { recursive: true })
      await copyFile(REAL_WATCH_IMAGE, join(scratchDir, 'watch-in', 'W-1.png'))
      vi.stubGlobal('fetch', vi.fn(async () => respond()))
      const { runSandboxWatchEditing } = await import('../apps/desktop/electron/sandbox/sandboxEditingPipeline')
      const { normalizeSandboxProductItem } = await import('../apps/desktop/src/sandbox/lib/normalizeSandboxProductData')
      const { createBatch } = await import('../apps/desktop/electron/services/batchRegistry')
      const legacy = await createBatch({ sourceDir: join(scratchDir, 'watch-in'), pipeline: ['watch'], title: 'w' })
      const failed: any[] = []
      const result = await runSandboxWatchEditing({
        inputDir: join(scratchDir, 'watch-in'),
        outputDir: join(scratchDir, 'watch-out'),
        batchId: legacy.id,
        items: [normalizeSandboxProductItem({ sku: 'W-1', imagePath: '/x.png', productType: 'watch', widthMm: 40, measureBy: 'Case' })],
        reporter: { stage: () => {}, stagesDone: () => {}, fail: (sku, failure) => failed.push({ sku, failure }), skuForFile: () => null },
      })
      expect(result.ok).toBe(false)
      expect(result.failure).toMatchObject({ code, retryable, stage: 'ai_detection', sku: 'W-1', productType: 'watch' })
      expect(failed).toHaveLength(1)
      expect(failed[0].failure.code).toBe(code)
      expect(result.items![0]).toMatchObject({ status: 'failed', failure: { code } })
    }, 60000)

    it('HTTP status reaches the technical details only', async () => {
      await mkdir(join(scratchDir, 'wi'), { recursive: true })
      await mkdir(join(scratchDir, 'wo'), { recursive: true })
      await copyFile(REAL_WATCH_IMAGE, join(scratchDir, 'wi', 'W-1.png'))
      vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 502 })))
      const { runSandboxWatchEditing } = await import('../apps/desktop/electron/sandbox/sandboxEditingPipeline')
      const { normalizeSandboxProductItem } = await import('../apps/desktop/src/sandbox/lib/normalizeSandboxProductData')
      const { createBatch } = await import('../apps/desktop/electron/services/batchRegistry')
      const legacy = await createBatch({ sourceDir: join(scratchDir, 'wi'), pipeline: ['watch'], title: 'w' })
      const result = await runSandboxWatchEditing({ inputDir: join(scratchDir, 'wi'), outputDir: join(scratchDir, 'wo'), batchId: legacy.id, items: [normalizeSandboxProductItem({ sku: 'W-1', imagePath: '/x.png', productType: 'watch', widthMm: 40, measureBy: 'Case' })] })
      expect(result.failure!.technicalMessage).toContain('HTTP 502')
      expect(result.failure!.message).not.toContain('502')
    }, 60000)

    it('Watch input problems are per item with their own codes: missing measureBy / width / invalid width', async () => {
      const { runSandboxWatchEditing } = await import('../apps/desktop/electron/sandbox/sandboxEditingPipeline')
      const { normalizeSandboxProductItem } = await import('../apps/desktop/src/sandbox/lib/normalizeSandboxProductData')
      const { createBatch } = await import('../apps/desktop/electron/services/batchRegistry')
      const legacy = await createBatch({ sourceDir: scratchDir, pipeline: ['watch'], title: 'w' })
      const w = (sku: string, extra: object) => normalizeSandboxProductItem({ sku, imagePath: '/x.png', productType: 'watch', ...extra } as any)
      const result = await runSandboxWatchEditing({
        inputDir: scratchDir, outputDir: scratchDir, batchId: legacy.id,
        items: [w('NO-BY', { widthMm: 40 }), w('NO-W', { measureBy: 'Case' }), w('BAD-W', { measureBy: 'Case', widthMm: -4 })],
      })
      expect(result.items!.map(i => i.failure?.code)).toEqual(['MISSING_WATCH_MEASURE_BY', 'MISSING_WATCH_WIDTH', 'MEASUREMENT_INVALID'])
    }, 60000)
  })
})

describe('post-processing script failure kinds — real subprocess, structured mapping', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-scriptfail-'))
    vi.resetModules()
  })
  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  async function run(source: string | null) {
    const { runPostProcessingScript, scriptFailure } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/scriptSubprocess')
    const script = join(scratchDir, 'fake.py')
    if (source !== null) await writeFile(script, source)
    const result = await runPostProcessingScript(script, [])
    return { result, failure: (scriptFailure('compressorNew', result) as any).failure }
  }

  it('missing Python package -> POSTPROCESSING_DEPENDENCY_MISSING naming the package, with the traceback only in technical details', async () => {
    const { result, failure } = await run('import definitely_not_installed_pkg_xyz\n')
    expect(result.failureKind).toBe('dependency_missing')
    expect(failure).toMatchObject({ code: 'POSTPROCESSING_DEPENDENCY_MISSING', stageDetail: 'compressorNew', retryable: true })
    expect(failure.message).toContain('definitely_not_installed_pkg_xyz')
    expect(failure.message).not.toContain('Traceback')
    expect(failure.technicalMessage).toContain('ModuleNotFoundError')
  })

  it('non-zero exit -> NONZERO_EXIT (stderr kept as technical detail)', async () => {
    const { failure } = await run(`import sys\nprint('boom detail', file=sys.stderr)\nsys.exit(3)\n`)
    expect(failure).toMatchObject({ code: 'POSTPROCESSING_NONZERO_EXIT' })
    expect(failure.technicalMessage).toContain('boom detail')
  })

  it('exit 0 without a readable result, and a result reporting ok:false, are malformed / failed — never success', async () => {
    expect((await run(`print('hello')\n`)).failure.code).toBe('POSTPROCESSING_MALFORMED_RESULT')
    expect((await run(`print('RESULT_JSON:{bad json')\n`)).failure.code).toBe('POSTPROCESSING_MALFORMED_RESULT')
    expect((await run(`print('RESULT_JSON:{"ok": false, "error": "no good"}')\n`)).failure.code).toBe('POSTPROCESSING_MALFORMED_RESULT')
  })

  it('script file missing -> POSTPROCESSING_SCRIPT_MISSING (not retryable)', async () => {
    const { failure } = await run(null)
    expect(failure).toMatchObject({ code: 'POSTPROCESSING_SCRIPT_MISSING', retryable: false })
  })

  describe('adapters (real scripts, or a fake project root) — every named script family', () => {
    async function adapter(name: string, input: string, output: string, productType = 'ring') {
      const mod = await import(/* @vite-ignore */ `../apps/desktop/electron/sandbox/sandboxPostProcessing/${name}Adapter`)
      return (mod[`${name}Adapter`] as any).run({ runId: 'r', productType, scriptId: name, inputDir: input, outputDir: output, batchId: 'b' })
    }

    it('EVERY real script reports its own script id in the failure when its input directory disappeared (source disappeared -> path failure)', async () => {
      for (const name of ['imageResizeNew', 'compressorNew', 'makeCompareRB', 'autoMCFF', 'removeShadows', 'autoMeasurementCalculator']) {
        const result = await adapter(name, join(scratchDir, 'gone'), join(scratchDir, `out-${name}`), name === 'removeShadows' ? 'watch' : name === 'autoMeasurementCalculator' ? 'earring' : 'ring')
        expect(result.ok, name).toBe(false)
        expect(result.failure, name).toBeTruthy()
        expect(result.failure.stageDetail, name).toBe(name)
        expect(result.failure.stage, name).toBe('post_processing')
        expect(result.failure.message, name).not.toMatch(/Traceback/)
      }
    })

    it('an unwritable destination (parent is a file) is POSTPROCESSING_PATH_FAILURE', async () => {
      const input = join(scratchDir, 'in'); await mkdir(input)
      await writeFile(join(input, 'A;frontFullImage.png'), 'x')
      const blocker = join(scratchDir, 'blocker'); await writeFile(blocker, 'file')
      const result = await adapter('makeCompareRB', input, join(blocker, 'out'))
      expect(result).toMatchObject({ ok: false, failure: { code: 'POSTPROCESSING_PATH_FAILURE', stageDetail: 'makeCompareRB', retryable: true } })
    })

    it('a script that claims success but produced no output is POSTPROCESSING_OUTPUT_MISSING for the compressor too', async () => {
      const fakeRoot = join(scratchDir, 'root')
      await mkdir(join(fakeRoot, 'postProcessing', 'compressorNew'), { recursive: true })
      await writeFile(join(fakeRoot, 'postProcessing', 'compressorNew', 'runner.py'), `import json;print('RESULT_JSON:'+json.dumps({'ok':True}))`)
      ;(await import('../apps/desktop/electron/sandbox/engine/runtime')).configureEngineRuntime({ projectRoot: () => fakeRoot })
      const input = join(scratchDir, 'in2'); await mkdir(input)
      const result = await adapter('compressorNew', input, join(scratchDir, 'out2'), 'watch')
      expect(result).toMatchObject({ ok: false, failure: { code: 'POSTPROCESSING_OUTPUT_MISSING', retryable: true } })
      expect(result.failure.message).toBe('compressorNew completed, but the expected output artifact was not created.')
    })
  })
})

describe('unsafe path', () => {
  it('a computed path that would leave its workspace raises UnsafePathError (mapped to UNSAFE_PATH by the engine)', async () => {
    vi.resetModules()
    scratchDir = tmpdir()
    const { assertWithinDir, UnsafePathError } = await import('../apps/desktop/electron/sandbox/sandboxWorkspace')
    expect(() => assertWithinDir(join(tmpdir(), 'a', 'b'), join(tmpdir(), 'a', 'c'))).toThrow(UnsafePathError)
    expect(() => assertWithinDir(join(tmpdir(), 'a', 'b'), join(tmpdir(), 'a', 'b', 'ok.png'))).not.toThrow()
  })
})
