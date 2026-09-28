// Retry Image, through the REAL Automation Engine: one failed image is re-run
// from the boundary its own persisted stage state says it failed at, in an
// isolated per-attempt workspace, using the same queues/SingleFlight/runners
// as a normal run — and successful images are never touched. Only true
// external edges are substituted (Watch AI fetch); scripts, Python runners,
// sharp, the registry and the filesystem are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, copyFile, readdir, readFile, stat, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

let scratchDir: string
const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')
const REAL_ROOT = join(REAL_APP_PATH, '..', '..')
const REAL_WATCH_IMAGE = join(REAL_ROOT, 'sampledata', '1688KM11.png')

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

const TERMINAL = ['completed', 'partially_completed', 'failed', 'cancelled']
async function waitFor(engine: any, id: string, pred: (s: any) => boolean, timeoutMs = 90000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const s = await engine.getJobState(id)
    if (s && pred(s)) return s
    await new Promise(r => setTimeout(r, 40))
  }
  throw new Error('timed out waiting for state')
}
const settled = (s: any) => TERMINAL.includes(s.status) && s.items.every((i: any) => !['queued', 'running'].includes(i.status))

const item = (run: any, sku: string) => run.items.find((i: any) => i.sku === sku)

async function loadEngine() {
  const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
  const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
  return { engine: automationEngine, createConfig: createInitialUniversalConfig }
}

async function snapshotDir(dir: string) {
  const out: Record<string, { bytes: string; mtime: number }> = {}
  for (const f of (await readdir(dir)).sort()) out[f] = { bytes: (await readFile(join(dir, f))).toString('base64'), mtime: (await stat(join(dir, f))).mtimeMs }
  return out
}

async function reviewFor(runId: string, batch: any) {
  const { sandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
  vi.spyOn(sandboxApiClient, 'getTemporaryBatchDetail').mockResolvedValue(batch)
  const { getSandboxReviewItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
  const { isItemReviewable } = await import('../apps/desktop/src/sandbox/lib/sandboxReviewData')
  const items = (await getSandboxReviewItems(runId))!
  return { items, reviewable: (sku: string) => isItemReviewable(items.find(r => r.sku === sku)!) }
}

// A project root where one post-processing script is replaced by a failing one.
async function rootWithFailingScript(scriptDir: string): Promise<string> {
  const fakeRoot = join(scratchDir, 'fake-root')
  await mkdir(join(fakeRoot, 'postProcessing', scriptDir), { recursive: true })
  for (const d of await readdir(join(REAL_ROOT, 'postProcessing'))) {
    if (d !== scriptDir) await symlink(join(REAL_ROOT, 'postProcessing', d), join(fakeRoot, 'postProcessing', d))
  }
  await writeFile(join(fakeRoot, 'postProcessing', scriptDir, 'runner.py'), 'import sys\nsys.stderr.write("injected failure")\nsys.exit(3)\n')
  return fakeRoot
}

describe('Retry Image — real engine', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-retry-'))
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
    'PREPROCESSING failure -> retry: only that image is re-run (concurrently across Ring and Bracelet), successful images are byte-for-byte untouched, state persists across reloads, and the retried image becomes reviewable',
    async () => {
      await ring(fx('r-ok.png')); await ring(fx('b-ok.png'))
      const batch = {
        id: 'rb', name: 'RB', productTypes: ['ring', 'bracelet'], imageCount: 4,
        images: [
          { sku: 'R-OK', imagePath: fx('r-ok.png'), productType: 'ring' },
          { sku: 'R-BAD', imagePath: fx('r-late.png'), productType: 'ring' }, // does not exist yet
          { sku: 'B-OK', imagePath: fx('b-ok.png'), productType: 'bracelet' },
          { sku: 'B-BAD', imagePath: fx('b-late.png'), productType: 'bracelet' },
        ],
      } as any
      const { engine, createConfig } = await loadEngine()
      const config = createConfig(batch)
      config.preprocessing.operation = 'none'
      const submitted = await engine.submitJob(batch, config)
      const first = await waitFor(engine, submitted.runId!, settled)
      expect(first.status).toBe('partially_completed')
      for (const sku of ['R-BAD', 'B-BAD']) expect(item(first, sku)).toMatchObject({ status: 'failed', failure: { code: 'SOURCE_IMAGE_MISSING', retryable: true } })
      const ringDir = first.pipelines.find((p: any) => p.productType === 'ring').postProcessingOutputDir as string
      const braceletDir = first.pipelines.find((p: any) => p.productType === 'bracelet').postProcessingOutputDir as string
      const beforeRing = await snapshotDir(ringDir)
      const beforeBracelet = await snapshotDir(braceletDir)
      expect(Object.keys(beforeRing).some(f => f.startsWith('R-OK'))).toBe(true)
      expect(Object.keys(beforeRing).some(f => f.startsWith('R-BAD'))).toBe(false)

      // The user supplies the missing images, then retries both — at the same time, on two products.
      await ring(fx('r-late.png')); await ring(fx('b-late.png'))
      const [r1, r2] = await Promise.all([engine.retryImage(first.id, 'ring', 'R-BAD'), engine.retryImage(first.id, 'bracelet', 'B-BAD')])
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      // Immediately (mid-retry) the persisted state already says so — a reloaded renderer would see exactly this.
      const mid = await engine.getJobState(first.id)
      for (const sku of ['R-BAD', 'B-BAD']) {
        expect(item(mid, sku)).toMatchObject({ status: 'running', attempt: 2, failure: null })
        expect(item(mid, sku).history).toHaveLength(1)
        expect(item(mid, sku).history[0]).toMatchObject({ attempt: 1, restartedFrom: 'preprocessing', failure: { code: 'SOURCE_IMAGE_MISSING' } })
      }
      expect(item(mid, 'R-OK').status).toBe('completed')
      // A second retry of the same image while it is in flight is refused.
      expect(await engine.retryImage(first.id, 'ring', 'R-BAD')).toMatchObject({ ok: false, failure: { code: 'RETRY_NOT_APPLICABLE' } })
      vi.resetModules()
      const reloadedMid = (await import('../apps/desktop/electron/sandbox/engine/automationEngine')).automationEngine
      expect(item((await reloadedMid.getJobState(first.id))!, 'R-BAD').attempt).toBe(2)

      const done = await waitFor(engine, first.id, s => settled(s) && s.status === 'completed')
      for (const sku of ['R-BAD', 'B-BAD']) {
        expect(item(done, sku)).toMatchObject({ status: 'completed', attempt: 2, failure: null })
        expect(item(done, sku).history[0].failure.code).toBe('SOURCE_IMAGE_MISSING') // the previous failure is kept
        expect(item(done, sku).stages.every((s: any) => s.status === 'done')).toBe(true)
      }
      // Successful images: files identical AND not even rewritten (mtime unchanged).
      const afterRing = await snapshotDir(ringDir)
      for (const [f, snap] of Object.entries(beforeRing)) {
        if (f === 'dimensions.csv' || f === 'measurements.xlsx') continue // batch-level measurement data is refreshed to include the retried image
        expect(afterRing[f], f).toEqual(snap)
      }
      for (const [f, snap] of Object.entries(beforeBracelet)) {
        if (f === 'dimensions.csv' || f === 'measurements.xlsx') continue
        expect((await snapshotDir(braceletDir))[f], f).toEqual(snap)
      }
      expect(Object.keys(afterRing).some(f => f.startsWith('R-BAD'))).toBe(true)
      // The retry ran in its own workspace, and only ever contained the retried image.
      const retryFiles = (await readdir(join(scratchDir, 'sandbox-runs', first.id, 'retry'), { recursive: true })).map(String)
      expect(retryFiles.some(f => f.includes('R-OK') || f.includes('B-OK'))).toBe(false)

      // Reload after completion: identical persisted state; retried images are reviewable in Final Review.
      vi.resetModules()
      const reloaded = (await import('../apps/desktop/electron/sandbox/engine/automationEngine')).automationEngine
      expect(await reloaded.getJobState(first.id)).toEqual(done)
      const review = await reviewFor(first.id, batch)
      for (const sku of ['R-OK', 'R-BAD', 'B-OK', 'B-BAD']) expect(review.reviewable(sku), sku).toBe(true)
      const bad = review.items.find(r => r.sku === 'R-BAD')!
      expect(bad.outputPath!.startsWith(ringDir)).toBe(true)
      expect(existsSync(bad.outputPath!)).toBe(true)
    },
    180000,
  )

  it(
    'EDITING failure (Watch AI) -> repeat failures keep a structured error + history; a fix + retry restarts at Editing (preprocessing NOT rerun) and Watch retries go through the ONE SingleFlight detection queue',
    async () => {
      await copyFile(REAL_WATCH_IMAGE, fx('w1.png')); await copyFile(REAL_WATCH_IMAGE, fx('w2.png'))
      const batch = {
        id: 'w', name: 'W', productTypes: ['watch'], imageCount: 2,
        images: [
          { sku: 'W-1', imagePath: fx('w1.png'), productType: 'watch', widthMm: 40, measureBy: 'Case' },
          { sku: 'W-2', imagePath: fx('w2.png'), productType: 'watch', widthMm: 38, measureBy: 'Case' },
        ],
      } as any
      let mode: 'down' | 'up' = 'down'
      let inFlight = 0, maxInFlight = 0, calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 40))
        inFlight--
        if (mode === 'down') return new Response('unavailable', { status: 503 })
        return new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [263, 4, 1312, 979], dial_bbox: [356, 57, 1212, 965] }), { status: 200 })
      }))
      const { engine, createConfig } = await loadEngine()
      const config = createConfig(batch)
      config.preprocessing.operation = 'none'
      const first = await waitFor(engine, (await engine.submitJob(batch, config)).runId!, settled)
      expect(first.status).toBe('failed')
      expect(item(first, 'W-1')).toMatchObject({ status: 'failed', failure: { code: 'WATCH_BOUNDARY_HTTP_ERROR', retryable: true, stage: 'ai_detection' } })
      const preprocessed = join(scratchDir, 'sandbox-runs', first.id, 'workspace', 'watch', 'preprocessed')
      const preBefore = await snapshotDir(preprocessed)

      // Retry while the service is STILL down: a NEW structured error, attempt 2, the first failure kept, still retryable.
      expect((await engine.retryImage(first.id, 'watch', 'W-1')).ok).toBe(true)
      const again = await waitFor(engine, first.id, s => item(s, 'W-1').attempt === 2 && item(s, 'W-1').status === 'failed')
      expect(item(again, 'W-1')).toMatchObject({ attempt: 2, failure: { code: 'WATCH_BOUNDARY_HTTP_ERROR', retryable: true, sku: 'W-1', productType: 'watch' } })
      expect(item(again, 'W-1').history).toHaveLength(1)
      expect(item(again, 'W-1').history[0]).toMatchObject({ attempt: 1, restartedFrom: 'editing', failure: { code: 'WATCH_BOUNDARY_HTTP_ERROR' } })
      expect(item(again, 'W-1').stages.find((s: any) => s.id === 'ai_detection').status).toBe('failed')
      expect(again.status).toBe('failed')
      await waitFor(engine, first.id, settled)
      expect(await engine.retryImage(first.id, 'watch', 'W-1')).toMatchObject({ ok: true }) // retryable again (attempt 3)
      await waitFor(engine, first.id, s => item(s, 'W-1').attempt === 3 && item(s, 'W-1').status === 'failed')

      // Service recovers. Retry BOTH images at once: detection stays single-flight.
      mode = 'up'
      calls = 0; maxInFlight = 0
      const results = await Promise.all([engine.retryImage(first.id, 'watch', 'W-1'), engine.retryImage(first.id, 'watch', 'W-2')])
      expect(results.every(r => r.ok)).toBe(true)
      const done = await waitFor(engine, first.id, s => settled(s) && s.status === 'completed', 120000)
      expect(maxInFlight).toBe(1) // SingleFlight: never two detection calls at once
      expect(calls).toBe(2)
      for (const sku of ['W-1', 'W-2']) {
        expect(item(done, sku)).toMatchObject({ status: 'completed', failure: null })
        expect(item(done, sku).history.at(-1)).toMatchObject({ restartedFrom: 'editing' })
      }
      expect(item(done, 'W-1').attempt).toBe(4)
      expect(item(done, 'W-1').history).toHaveLength(3) // every earlier failure is kept
      // Preprocessing was NOT rerun: its artifacts are untouched.
      expect(await snapshotDir(preprocessed)).toEqual(preBefore)
      // Post-processing ran for real and both are reviewable.
      const finalDir = done.pipelines[0].postProcessingOutputDir as string
      expect((await readdir(finalDir)).some(f => f.startsWith('W-1'))).toBe(true)
      const review = await reviewFor(first.id, batch)
      expect(review.reviewable('W-1')).toBe(true)
      expect(review.reviewable('W-2')).toBe(true)
    },
    240000,
  )

  it(
    'a Watch retry in one run and a Watch retry in another share the SAME single-flight detection queue',
    async () => {
      await copyFile(REAL_WATCH_IMAGE, fx('w.png'))
      const mk = (id: string) => ({ id, name: id, productTypes: ['watch'], imageCount: 1, images: [{ sku: `${id}-W`, imagePath: fx('w.png'), productType: 'watch', widthMm: 40, measureBy: 'Case' }] }) as any
      let up = false
      let inFlight = 0, maxInFlight = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 60))
        inFlight--
        if (!up) return new Response('x', { status: 503 })
        return new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [263, 4, 1312, 979], dial_bbox: [356, 57, 1212, 965] }), { status: 200 })
      }))
      const { engine, createConfig } = await loadEngine()
      const runs: string[] = []
      for (const id of ['A', 'B']) {
        const batch = mk(id)
        const cfg = createConfig(batch); cfg.preprocessing.operation = 'none'
        const run = await waitFor(engine, (await engine.submitJob(batch, cfg)).runId!, settled)
        expect(run.status).toBe('failed')
        runs.push(run.id)
      }
      up = true; maxInFlight = 0
      const rs = await Promise.all([engine.retryImage(runs[0], 'watch', 'A-W'), engine.retryImage(runs[1], 'watch', 'B-W')])
      expect(rs.every(r => r.ok)).toBe(true)
      await Promise.all(runs.map(id => waitFor(engine, id, s => settled(s) && s.status === 'completed', 120000)))
      expect(maxInFlight).toBe(1)
    },
    240000,
  )

  it(
    'POST-PROCESSING failure -> retry re-runs post-processing from the existing editing artifact (preprocessing/editing NOT rerun); a repeat failure is a structured error; only the retried image is merged',
    async () => {
      await ring(fx('a.png')); await ring(fx('b.png'))
      const batch = {
        id: 'pp', name: 'PP', productTypes: ['ring'], imageCount: 2,
        images: [{ sku: 'R-A', imagePath: fx('a.png'), productType: 'ring' }, { sku: 'R-B', imagePath: fx('b.png'), productType: 'ring' }],
      } as any
      const { configureEngineRuntime } = await import('../apps/desktop/electron/sandbox/engine/runtime')
      const brokenRoot = await rootWithFailingScript('compressorNew')
      configureEngineRuntime({ projectRoot: () => brokenRoot })
      const { engine, createConfig } = await loadEngine()
      const config = createConfig(batch)
      config.preprocessing.operation = 'none'
      const first = await waitFor(engine, (await engine.submitJob(batch, config)).runId!, settled)
      expect(first.status).toBe('failed')
      for (const sku of ['R-A', 'R-B']) {
        expect(item(first, sku)).toMatchObject({ status: 'failed', failure: { code: 'POSTPROCESSING_NONZERO_EXIT', stageDetail: 'compressorNew', retryable: true } })
        expect(item(first, sku).stages.find((s: any) => s.id === 'editing').status).toBe('done') // earlier stages stay done
      }
      const wsDir = join(scratchDir, 'sandbox-runs', first.id, 'workspace', 'ring')
      const editingBefore = await snapshotDir(join(wsDir, 'editing-output'))
      const preBefore = await snapshotDir(join(wsDir, 'preprocessed'))

      // Still broken: the retry fails again with a fresh structured error; nothing is merged, the run stays failed.
      expect((await engine.retryImage(first.id, 'ring', 'R-A')).ok).toBe(true)
      const stillBroken = await waitFor(engine, first.id, s => item(s, 'R-A').attempt === 2 && item(s, 'R-A').status === 'failed')
      expect(item(stillBroken, 'R-A')).toMatchObject({ failure: { code: 'POSTPROCESSING_NONZERO_EXIT', stageDetail: 'compressorNew', sku: 'R-A' } })
      expect(item(stillBroken, 'R-A').history[0]).toMatchObject({ restartedFrom: 'post_processing' })
      await waitFor(engine, first.id, settled)

      // Fixed: retry R-A only.
      configureEngineRuntime({ projectRoot: () => REAL_ROOT })
      expect((await engine.retryImage(first.id, 'ring', 'R-A')).ok).toBe(true)
      const partial = await waitFor(engine, first.id, s => settled(s) && item(s, 'R-A').status === 'completed')
      expect(item(partial, 'R-B').status).toBe('failed') // the sibling was not retried, not touched
      expect(partial.status).toBe('partially_completed')
      const finalDir = partial.pipelines[0].postProcessingOutputDir as string
      const files = await readdir(finalDir)
      expect(files.some(f => f.startsWith('R-A'))).toBe(true)
      expect(files.some(f => f.startsWith('R-B'))).toBe(false)

      // Retry R-B too.
      expect((await engine.retryImage(first.id, 'ring', 'R-B')).ok).toBe(true)
      const done = await waitFor(engine, first.id, s => settled(s) && s.status === 'completed')
      expect(item(done, 'R-A').attempt).toBe(3) // R-A: original + failed retry + successful retry
      // Preprocessing and Editing artifacts were never rerun / rewritten.
      expect(await snapshotDir(join(wsDir, 'editing-output'))).toEqual(editingBefore)
      expect(await snapshotDir(join(wsDir, 'preprocessed'))).toEqual(preBefore)
      const review = await reviewFor(first.id, batch)
      expect(review.reviewable('R-A')).toBe(true)
      expect(review.reviewable('R-B')).toBe(true)
    },
    240000,
  )

  it(
    'batch-level measurement data (autoMCFF dimensions.csv) is refreshed over the merged set after a retry — it covers the retried image AND the earlier ones',
    async () => {
      await ring(fx('a.png'))
      const batch = {
        id: 'm', name: 'M', productTypes: ['ring'], imageCount: 2,
        images: [{ sku: 'R-A', imagePath: fx('a.png'), productType: 'ring' }, { sku: 'R-LATE', imagePath: fx('late.png'), productType: 'ring' }],
      } as any
      const { engine, createConfig } = await loadEngine()
      const config = createConfig(batch)
      config.preprocessing.operation = 'none'
      config.postProcessingByProduct.ring = { autoMCFF: true }
      const first = await waitFor(engine, (await engine.submitJob(batch, config)).runId!, settled)
      expect(first.status).toBe('partially_completed')
      const finalDir = first.pipelines[0].postProcessingOutputDir as string
      const csv = join(finalDir, 'dimensions.csv')
      expect(existsSync(csv)).toBe(true)
      const before = await readFile(csv, 'utf-8')
      expect(before).toContain('R-A')
      expect(before).not.toContain('R-LATE')

      await ring(fx('late.png'))
      expect((await engine.retryImage(first.id, 'ring', 'R-LATE')).ok).toBe(true)
      const done = await waitFor(engine, first.id, s => settled(s) && s.status === 'completed')
      const after = await readFile(csv, 'utf-8')
      expect(after).toContain('R-A')
      expect(after).toContain('R-LATE')
      expect(done.pipelines[0].postProcessingArtifacts.some((a: any) => a.kind === 'measurementData' && a.data.csvPath === csv)).toBe(true)
    },
    180000,
  )

  it('refuses precisely (RETRY_NOT_APPLICABLE, nothing changed) for an unknown run/image, a completed image, and a failure that needs its input fixed first', async () => {
    await ring(fx('ok.png')); await writeFile(fx('corrupt.png'), 'not a png')
    const batch = {
      id: 'ref', name: 'Ref', productTypes: ['ring'], imageCount: 2,
      images: [{ sku: 'R-OK', imagePath: fx('ok.png'), productType: 'ring' }, { sku: 'R-CORRUPT', imagePath: fx('corrupt.png'), productType: 'ring' }],
    } as any
    const { engine, createConfig } = await loadEngine()
    const config = createConfig(batch); config.preprocessing.operation = 'none'
    const run = await waitFor(engine, (await engine.submitJob(batch, config)).runId!, settled)
    expect(item(run, 'R-CORRUPT').failure).toMatchObject({ code: 'SOURCE_IMAGE_UNREADABLE', retryable: false })

    for (const [runId, type, sku] of [['nope', 'ring', 'R-OK'], [run.id, 'ring', 'GHOST'], [run.id, 'ring', 'R-OK'], [run.id, 'ring', 'R-CORRUPT']] as const) {
      const result = await engine.retryImage(runId, type, sku)
      expect(result, `${runId}/${sku}`).toMatchObject({ ok: false, failure: { code: 'RETRY_NOT_APPLICABLE' } })
      expect(result.error).toBeTruthy()
    }
    expect(await engine.getJobState(run.id)).toEqual(run) // nothing was modified
  }, 120000)

  it('an image left "running" by a process that died mid-retry is recovered as RUN_INTERRUPTED — retryable again, with its earlier failure kept in history', async () => {
    await ring(fx('ok.png'))
    const batch = {
      id: 'rec', name: 'Rec', productTypes: ['ring'], imageCount: 2,
      images: [{ sku: 'R-OK', imagePath: fx('ok.png'), productType: 'ring' }, { sku: 'R-LATE', imagePath: fx('late.png'), productType: 'ring' }],
    } as any
    const { engine, createConfig } = await loadEngine()
    const config = createConfig(batch); config.preprocessing.operation = 'none'
    const first = await waitFor(engine, (await engine.submitJob(batch, config)).runId!, settled)
    expect(item(first, 'R-LATE').status).toBe('failed')

    // Simulate the engine dying mid-retry: persisted state says "running", but no retry exists in memory.
    const { updateSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const items = structuredClone(first.items)
    const late = items.find((i: any) => i.sku === 'R-LATE')
    late.history = [{ attempt: 1, failure: late.failure, failedAt: late.finishedAt, restartedFrom: 'preprocessing' }]
    late.attempt = 2; late.status = 'running'; late.failure = null; late.error = null
    await updateSandboxRun(first.id, { items } as any)

    vi.resetModules() // the "restarted" process
    const { engine: restarted } = await loadEngine()
    expect(await restarted.recoverInterruptedJobs()).toEqual([first.id])
    const after = (await restarted.getJobState(first.id))!
    expect(item(after, 'R-LATE')).toMatchObject({ status: 'failed', attempt: 2, failure: { code: 'RUN_INTERRUPTED', sku: 'R-LATE' } })
    expect(item(after, 'R-LATE').history).toHaveLength(1)
    expect(item(after, 'R-OK').status).toBe('completed')
    expect(after.status).toBe('partially_completed')

    await ring(fx('late.png'))
    expect((await restarted.retryImage(first.id, 'ring', 'R-LATE')).ok).toBe(true)
    const done = await waitFor(restarted, first.id, s => settled(s) && s.status === 'completed')
    expect(item(done, 'R-LATE')).toMatchObject({ status: 'completed', attempt: 3 })
    expect(item(done, 'R-LATE').history).toHaveLength(2)
  }, 120000)
})
