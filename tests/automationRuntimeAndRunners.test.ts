// Runtime capability failures (Python unavailable / dependency missing) and
// the mapping of the real runners' structured progress + completion signals
// (UBG preprocessing events, Ring/Earring runner events, done payload kinds)
// into per-image progress and structured failures. The Python interpreter
// resolver and the ProcessingBackend seam are substituted; everything under
// test (preflight, adapters, pipelines, engine failure mapping) is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

let scratchDir: string
const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')
const resolver = { post: '/usr/bin/python3' as string | null, pre: '/usr/bin/python3' as string | null, modules: true }

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir, getAppPath: () => REAL_APP_PATH },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../apps/desktop/electron/services/pythonResolver', () => ({
  resolvePostProcessingPython: async () => resolver.post,
  resolvePreprocessingPython: async () => resolver.pre,
  checkPythonModules: async () => resolver.modules,
}))

const startPre = vi.fn()
const startRB = vi.fn()
vi.mock('../apps/desktop/electron/sandbox/processingBackend', () => ({
  localProcessingBackend: {
    preprocessing: { start: (...a: unknown[]) => startPre(...a), cancel: async () => ({ ok: true }) },
    ringBracelet: { start: (...a: unknown[]) => startRB(...a), cancel: async () => ({ ok: true }) },
  },
}))

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'wpa-runtime-'))
  Object.assign(resolver, { post: '/usr/bin/python3', pre: '/usr/bin/python3', modules: true })
  startPre.mockReset()
  startRB.mockReset()
  vi.resetModules()
})
afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('Python runtime capability', () => {
  async function tryCreate(operation: 'both' | 'none', productType = 'ring') {
    const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const img = join(scratchDir, 'i.png')
    await sharp({ create: { width: 30, height: 30, channels: 4, background: '#fff' } }).png().toFile(img)
    const batch = { id: 'b', name: 'B', productTypes: [productType], imageCount: 1, images: [{ sku: 'S', imagePath: img, productType }] } as any
    const config = createInitialUniversalConfig(batch)
    config.preprocessing.operation = operation
    return automationEngine.createJob(batch, config)
  }

  it('Python unavailable is caught at preflight as PYTHON_UNAVAILABLE (retryable) — before any work starts, and no job is created', async () => {
    resolver.post = null
    const result = await tryCreate('none')
    expect(result.ok).toBe(false)
    expect(result.failure).toMatchObject({ code: 'PYTHON_UNAVAILABLE', stage: 'preflight', retryable: true })
    expect(result.failure!.action).toMatch(/Python/)
  })

  it('the preprocessing interpreter (torch/sam2/basicsr) is only required when the operation actually uses Python', async () => {
    resolver.pre = null
    expect((await tryCreate('none')).ok).toBe(true)
    const withBg = await tryCreate('both')
    expect(withBg.ok).toBe(false)
    expect(withBg.failure).toMatchObject({ code: 'PYTHON_UNAVAILABLE' })
  })

  it('every real post-processing adapter reports POSTPROCESSING_PYTHON_UNAVAILABLE naming its script when no interpreter exists', async () => {
    resolver.post = null
    const dir = join(scratchDir, 'in'); await mkdir(dir)
    await writeFile(join(dir, 'A.png'), 'x')
    for (const name of ['imageResizeNew', 'compressorNew', 'makeCompareRB', 'removeShadows']) {
      const mod = await import(/* @vite-ignore */ `../apps/desktop/electron/sandbox/sandboxPostProcessing/${name}Adapter`)
      const result = await (mod[`${name}Adapter`] as any).run({ runId: 'r', productType: 'ring', scriptId: name, inputDir: dir, outputDir: join(scratchDir, `o-${name}`), batchId: 'b' })
      expect(result, name).toMatchObject({ ok: false, failure: { code: 'POSTPROCESSING_PYTHON_UNAVAILABLE', stageDetail: name, retryable: true } })
    }
  })

  it('autoMeasurementCalculator needs pandas/openpyxl: missing -> POSTPROCESSING_DEPENDENCY_MISSING (unavailable), never a fake success', async () => {
    resolver.modules = false
    const { autoMeasurementCalculatorAdapter } = await import('../apps/desktop/electron/sandbox/sandboxPostProcessing/autoMeasurementCalculatorAdapter')
    const result = await autoMeasurementCalculatorAdapter.run({ runId: 'r', productType: 'earring', scriptId: 'autoMeasurementCalculator', inputDir: scratchDir, outputDir: join(scratchDir, 'o'), batchId: 'b' })
    expect(result).toMatchObject({ ok: false, unavailable: true, failure: { code: 'POSTPROCESSING_DEPENDENCY_MISSING', stageDetail: 'autoMeasurementCalculator' } })
    expect((result as any).failure.message).toContain('pandas, openpyxl')
  })
})

describe('runner events -> per-image progress and structured failures', () => {
  type Call = [string, ...unknown[]]
  function makeReporter() {
    const calls: Call[] = []
    return {
      calls,
      reporter: {
        stage: (sku: string, id: string, status: string) => calls.push(['stage', sku, id, status]),
        stagesDone: (sku: string, ids: string[]) => calls.push(['done', sku, ids.join(',')]),
        fail: (sku: string, failure: any, stageId?: string) => calls.push(['fail', sku, failure.code, stageId, failure.technicalMessage]),
        skuForFile: (f: string) => f.replace(/\.[^.]+$/, ''),
      },
    }
  }

  async function preprocess(events: () => void, done: Record<string, unknown>, config: any = { operation: 'both', upscaleFactor: 2, trim: false, rotate: 0, resizeToHeight: null }) {
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { SingleFlightQueue } = await import('../apps/desktop/electron/services/singleFlightQueue')
    const { runSandboxPreprocessingForProduct } = await import('../apps/desktop/electron/sandbox/sandboxPreprocessingPipeline')
    const { calls, reporter } = makeReporter()
    startPre.mockImplementation(async () => {
      // Progress events fire BEFORE start() resolves (the jobId is unknown
      // yet) — the observer must buffer and replay them. Completion arrives
      // later, as a real process's would.
      events()
      setTimeout(() => notifyAllWindows('preprocess:done', { jobId: 'job-1', exitCode: 0, succeeded: 0, failed: 0, totalDurationMs: 1, cancelledByUser: false, ...done }), 5)
      return { ok: true, jobId: 'job-1' }
    })
    const result = await runSandboxPreprocessingForProduct({ runId: 'r', productType: 'ring', batchId: 'b', config, preprocessingDispatchQueue: new SingleFlightQueue(), reporter: reporter as any })
    return { result, calls }
  }

  it('UBG stage events become Upscaling -> Background Removal progress, ending with the runner "complete"', async () => {
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const emit = (e: Record<string, unknown>) => notifyAllWindows('preprocess:event', { jobId: 'job-1', ...e })
    const { result, calls } = await preprocess(
      () => {
        emit({ type: 'progress', image: 'A.jpg', stage: 'upscale', status: 'start' })
        emit({ type: 'heartbeat', image: 'A.jpg', stage: 'upscale', elapsed_ms: 2000 }) // ignored noise
        emit({ type: 'progress', image: 'A.jpg', stage: 'upscale', status: 'done' })
        emit({ type: 'progress', image: 'A.jpg', stage: 'birefnet', status: 'start' })
        emit({ type: 'progress', image: 'A.jpg', stage: 'sam', status: 'start' })
        emit({ type: 'progress', image: 'A.jpg', stage: 'save', status: 'start' })
        emit({ type: 'complete', image: 'A.jpg' })
      },
      { succeeded: 1 },
    )
    expect(result.ok).toBe(true)
    expect(calls).toEqual([
      ['stage', 'A', 'upscale', 'running'],
      ['stage', 'A', 'upscale', 'done'],
      ['stage', 'A', 'background_removal', 'running'],
      ['stage', 'A', 'background_removal', 'running'],
      ['done', 'A', 'background_removal'],
      ['done', 'A', 'upscale,background_removal'],
    ])
    expect(startPre.mock.calls[0][0]).toMatchObject({ operations: ['background_removal', 'upscale'], scaleFactor: 2 })
  })

  it('a per-image runner error is attributed to the stage that was running: background removal vs upscaling vs unknown', async () => {
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const emit = (e: Record<string, unknown>) => notifyAllWindows('preprocess:event', { jobId: 'job-1', ...e })
    const { result, calls } = await preprocess(
      () => {
        emit({ type: 'progress', image: 'BG.jpg', stage: 'birefnet', status: 'start' })
        emit({ type: 'error', image: 'BG.jpg', error: 'CUDA out of memory\nTraceback...' })
        emit({ type: 'progress', image: 'UP.jpg', stage: 'upscale', status: 'start' })
        emit({ type: 'error', image: 'UP.jpg', error: 'upscaler blew up' })
        emit({ type: 'error', image: 'EARLY.jpg', error: 'could not open' })
        emit({ type: 'complete', image: 'OK.jpg' })
      },
      { succeeded: 1, failed: 3 },
    )
    expect(result.ok).toBe(true) // one image succeeded: product continues
    const fails = calls.filter(c => c[0] === 'fail')
    expect(fails).toEqual([
      ['fail', 'BG', 'BACKGROUND_REMOVAL_FAILED', 'background_removal', 'CUDA out of memory\nTraceback...'],
      ['fail', 'UP', 'UPSCALE_FAILED', 'upscale', 'upscaler blew up'],
      ['fail', 'EARLY', 'PREPROCESSING_FAILED', undefined, 'could not open'],
    ])
  })

  it.each([
    ['runner could not start', { spawnError: 'ENOENT', failureKind: 'spawn' }, 'PREPROCESSING_START_FAILED', true],
    ['runner went unresponsive', { spawnError: 'no output for 60s', failureKind: 'timeout' }, 'PREPROCESSING_FAILED', true],
    ['missing Python package', { fatalError: "ModuleNotFoundError: No module named 'sam2'" }, 'PYTHON_DEPENDENCY_MISSING', true],
    ['every image failed', { failed: 4 }, 'PREPROCESSING_FAILED', true],
    ['processed nothing', {}, 'PREPROCESSING_INVALID_OUTPUT', true],
  ] as const)('product-level: %s -> %s', async (_label, done, code, retryable) => {
    const { result } = await preprocess(() => {}, done as any)
    expect(result.ok).toBe(false)
    expect(result.failure).toMatchObject({ code, retryable, stage: code === 'PYTHON_DEPENDENCY_MISSING' ? 'preflight' : 'preprocessing', productType: 'ring' })
  })

  it('a runner that fails to start at all is PREPROCESSING_START_FAILED with the runner message as technical detail', async () => {
    startPre.mockResolvedValue({ ok: false, error: 'A preprocessing job is already running' })
    const { SingleFlightQueue } = await import('../apps/desktop/electron/services/singleFlightQueue')
    const { runSandboxPreprocessingForProduct } = await import('../apps/desktop/electron/sandbox/sandboxPreprocessingPipeline')
    const result = await runSandboxPreprocessingForProduct({ runId: 'r', productType: 'ring', batchId: 'b', config: { operation: 'both', upscaleFactor: 2, trim: false, rotate: 0, resizeToHeight: null }, preprocessingDispatchQueue: new SingleFlightQueue() })
    expect(result.failure).toMatchObject({ code: 'PREPROCESSING_START_FAILED', technicalMessage: 'A preprocessing job is already running' })
  })

  async function edit(events: (emit: (e: Record<string, unknown>) => void) => void, done: Record<string, unknown>, productType: 'ring' | 'bracelet' = 'ring') {
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { SingleFlightQueue } = await import('../apps/desktop/electron/services/singleFlightQueue')
    const { runSandboxRingOrBraceletEditing } = await import('../apps/desktop/electron/sandbox/sandboxEditingPipeline')
    const { calls, reporter } = makeReporter()
    startRB.mockImplementation(async () => {
      events(e => notifyAllWindows('ring-bracelet:event', { jobId: 'j', ...e }))
      setTimeout(() => notifyAllWindows('ring-bracelet:done', { jobId: 'j', exitCode: 0, succeeded: 0, failed: 0, totalDurationMs: 1, cancelledByUser: false, ...done }), 5)
      return { ok: true, jobId: 'j' }
    })
    const result = await runSandboxRingOrBraceletEditing({ productType, inputDir: 'i', outputDir: 'o', batchId: 'b', dispatchQueue: new SingleFlightQueue(), reporter: reporter as any })
    return { result, calls }
  }

  it('Ring editing events: Ring Segmentation runs first, then the rest of Ring Editing; per-image errors are attributed to the stage that failed', async () => {
    const { result, calls } = await edit(
      emit => {
        emit({ type: 'progress', image: 'A.png', stage: 'ring_segmentation', status: 'start' })
        emit({ type: 'progress', image: 'A.png', stage: 'shadow', status: 'start' })
        emit({ type: 'complete', image: 'A.png' })
        emit({ type: 'progress', image: 'B.png', stage: 'ring_segmentation', status: 'start' })
        emit({ type: 'error', image: 'B.png', error: '[RING_SEGMENTATION_INFERENCE_FAILED] InvalidArgument: bad tensor' })
        emit({ type: 'progress', image: 'C.png', stage: 'ring_segmentation', status: 'start' })
        emit({ type: 'progress', image: 'C.png', stage: 'shadow', status: 'start' })
        emit({ type: 'error', image: 'C.png', error: 'shadow blew up' })
      },
      { succeeded: 1, failed: 2 },
    )
    expect(result).toMatchObject({ ok: true, completedSkus: ['A'] })
    expect(calls).toEqual([
      ['stage', 'A', 'ring_segmentation', 'running'],
      ['done', 'A', 'ring_segmentation'],
      ['stage', 'A', 'editing', 'running'],
      ['done', 'A', 'ring_segmentation,editing'],
      ['stage', 'B', 'ring_segmentation', 'running'],
      ['fail', 'B', 'RING_SEGMENTATION_INFERENCE_FAILED', 'ring_segmentation', 'InvalidArgument: bad tensor'],
      ['stage', 'C', 'ring_segmentation', 'running'],
      ['done', 'C', 'ring_segmentation'],
      ['stage', 'C', 'editing', 'running'],
      ['fail', 'C', 'EDITING_RUNNER_FAILED', 'editing', 'shadow blew up'],
    ])
  })

  it('Bracelet editing events are unchanged: one CV stage (shank_mask) maps to the single editing stage — no Ring Segmentation involvement', async () => {
    const { result, calls } = await edit(
      emit => {
        emit({ type: 'progress', image: 'A.png', stage: 'shank_mask', status: 'start' })
        emit({ type: 'complete', image: 'A.png' })
        emit({ type: 'progress', image: 'B.png', stage: 'shank_mask', status: 'start' })
        emit({ type: 'error', image: 'B.png', error: '[RING_SEGMENTATION_INFERENCE_FAILED] must not be interpreted for a bracelet' })
      },
      { succeeded: 1, failed: 1 },
      'bracelet',
    )
    expect(result).toMatchObject({ ok: true, completedSkus: ['A'] })
    expect(calls).toEqual([
      ['stage', 'A', 'editing', 'running'],
      ['done', 'A', 'editing'],
      ['stage', 'B', 'editing', 'running'],
      ['fail', 'B', 'EDITING_RUNNER_FAILED', 'editing', '[RING_SEGMENTATION_INFERENCE_FAILED] must not be interpreted for a bracelet'],
    ])
  })

  it.each([
    ['MODEL_UNAVAILABLE', 'RING_SEGMENTATION_MODEL_UNAVAILABLE', true],
    ['RUNTIME_ERROR', 'RING_SEGMENTATION_RUNTIME_ERROR', true],
    ['INFERENCE_FAILED', 'RING_SEGMENTATION_INFERENCE_FAILED', true],
    ['OUTPUT_MISSING', 'RING_SEGMENTATION_OUTPUT_MISSING', false],
    ['OUTPUT_INVALID', 'RING_SEGMENTATION_OUTPUT_INVALID', true],
  ] as const)('a per-image [RING_SEGMENTATION_%s] error and a job-level fatal with that token both become the structured %s', async (kind, code, retryable) => {
    const text = `[RING_SEGMENTATION_${kind}] onnxruntime says: ${'x'.repeat(30)}`
    const perImage = await edit(emit => emit({ type: 'error', image: 'A.png', error: text }), { succeeded: 0, failed: 1 })
    expect(perImage.calls).toEqual([['fail', 'A', code, 'ring_segmentation', `onnxruntime says: ${'x'.repeat(30)}`]])
    const fatal = await edit(() => {}, { fatalError: text })
    expect(fatal.result).toMatchObject({ ok: false, failure: { code, retryable, stage: 'editing', stageDetail: 'Ring Segmentation', productType: 'ring', technicalMessage: `onnxruntime says: ${'x'.repeat(30)}` } })
    expect(fatal.result.failure!.message).not.toContain('onnxruntime') // raw text is never the primary message
  })

  it.each([
    ['launch failure', { spawnError: 'x', failureKind: 'spawn' }, 'EDITING_LAUNCH_FAILED'],
    ['timeout', { spawnError: 'x', failureKind: 'timeout' }, 'EDITING_TIMEOUT'],
    ['crash with a fatal message', { fatalError: 'segfault' }, 'EDITING_RUNNER_FAILED'],
    ['malformed/empty result', {}, 'EDITING_OUTPUT_MISSING'],
  ] as const)('editing product-level: %s -> %s', async (_l, done, code) => {
    const { result } = await edit(() => {}, done as any)
    expect(result).toMatchObject({ ok: false, failure: { code, stage: 'editing', productType: 'ring' } })
  })
})
