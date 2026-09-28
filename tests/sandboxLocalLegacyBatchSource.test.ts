// DEVELOPMENT/TESTING bridge — existing local Legacy batches as a Sandbox
// Temporary Batch source. Uses the REAL batchRegistry (electron mocked only
// for app.getPath/getAppPath, pointing at a scratch userData dir), real
// fixture folders/spreadsheets, and — for the integration test — the real
// Sandbox orchestrator. The adapter itself is never mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

let scratchDir: string
const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')

vi.mock('electron', () => ({
  app: { getPath: () => join(scratchDir, 'userData'), getAppPath: () => REAL_APP_PATH },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}))

async function png(path: string, size = 80) {
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.hypot(x - size / 2, y - size / 2) / (size * 0.35)
      const ring = d > 0.6 && d < 1
      buf[i] = 180; buf[i + 1] = 150; buf[i + 2] = 80; buf[i + 3] = ring ? 255 : 0
    }
  }
  await sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toFile(path)
}

// Creates a real Legacy batch through the real registry, the same calls the
// Legacy flow makes (createBatch + updateStage), so productType is derived
// by the real batchModel rather than hand-written into the index.
async function makeLegacyBatch(opts: {
  title: string
  sourceDir: string
  stage: 'preprocessing' | 'editing' | 'watch'
  config: Record<string, unknown>
}) {
  const { createBatch, updateStage } = await import('../apps/desktop/electron/services/batchRegistry')
  const batch = await createBatch({ sourceDir: opts.sourceDir, pipeline: [opts.stage], title: opts.title })
  await updateStage(batch.id, opts.stage, { config: opts.config, inputDir: opts.sourceDir, status: 'completed' })
  return batch
}

async function snapshotRegistry(): Promise<Record<string, string>> {
  const dir = join(scratchDir, 'userData', 'batches')
  const out: Record<string, string> = {}
  for (const f of (await readdir(dir)).sort()) out[f] = await readFile(join(dir, f), 'utf-8')
  return out
}

describe('local Legacy batch -> Sandbox Temporary Batch (development/testing bridge)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-local-legacy-test-'))
    vi.resetModules()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('A. enumerates existing Legacy batches from the real registry, with only facts the registry holds, hiding unusable ones with a reason', async () => {
    const ringDir = join(scratchDir, 'src', 'ring')
    await mkdir(ringDir, { recursive: true })
    await png(join(ringDir, 'R1.png'))
    await png(join(ringDir, 'R2.png'))
    await writeFile(join(ringDir, '._R1.png'), 'apple double') // never an image
    await writeFile(join(ringDir, 'notes.txt'), 'x')
    await makeLegacyBatch({ title: 'My Ring Batch', sourceDir: ringDir, stage: 'editing', config: { product: 'ring' } })

    // unusable: source folder missing (unmounted drive)
    await makeLegacyBatch({ title: 'Gone Drive', sourceDir: join(scratchDir, 'not-mounted'), stage: 'editing', config: { product: 'ring' } })
    // unusable: no recorded product type
    const noType = join(scratchDir, 'src', 'notype')
    await mkdir(noType, { recursive: true })
    await png(join(noType, 'A.png'))
    const { createBatch } = await import('../apps/desktop/electron/services/batchRegistry')
    await createBatch({ sourceDir: noType, pipeline: ['preprocessing'], title: 'No Type' })

    const { listLocalTestBatches } = await import('../apps/desktop/electron/sandbox/localLegacyBatchSource')
    const result = await listLocalTestBatches()

    expect(result.batches).toHaveLength(1)
    expect(result.batches[0]).toMatchObject({
      id: expect.stringMatching(/^local-legacy:batch-/),
      name: 'My Ring Batch',
      productTypes: ['ring'],
      imageCount: 2, // ._ sidecar and .txt excluded
      legacyStatus: expect.any(String),
      sourceDir: ringDir,
    })
    expect(result.batches[0].createdAt).toBeTruthy()
    const reasons = Object.fromEntries(result.hidden.map(h => [h.name, h.reason]))
    expect(reasons['Gone Drive']).toMatch(/not found/i)
    expect(reasons['No Type']).toMatch(/product type/i)
  })

  it('B/D. the adapter preserves Legacy metadata exactly per product type — Watch sheet width/height/measureBy, Earring classification, Ring/Bracelet carry none — and never invents any', async () => {
    const { legacyBatchToSandboxTemporaryBatch } = await import('../apps/desktop/electron/sandbox/localLegacyBatchSource')
    const base = { legacyBatchId: 'batch-x', name: 'N', sourceDir: join(scratchDir, 'src') }

    const watch = legacyBatchToSandboxTemporaryBatch({
      ...base,
      productType: 'watch',
      imageFiles: ['W1.png', 'W2.png', 'W3.png', 'W4.png'],
      watchRows: {
        w1: { widthMm: 42, heightMm: 50, measureBy: 'Case' },
        w2: { widthMm: 30.5, heightMm: 0, measureBy: ' dial ' },
        w3: { widthMm: 0, heightMm: 0, measureBy: 'Sideways' }, // unparsable/unknown -> absent, not defaulted
        // w4: no row at all
      },
    })
    expect(watch.id).toBe('local-legacy:batch-x')
    expect(watch.productTypes).toEqual(['watch'])
    expect(watch.imageCount).toBe(4)
    const [w1, w2, w3, w4] = watch.images
    expect(w1).toMatchObject({ sku: 'W1', productType: 'watch', widthMm: 42, heightMm: 50, measureBy: 'Case' })
    expect(w2).toMatchObject({ sku: 'W2', widthMm: 30.5, measureBy: 'Dial' })
    expect(w2.heightMm).toBeUndefined()
    expect(w3.widthMm).toBeUndefined()
    expect(w3.measureBy).toBeUndefined()
    expect(w4.widthMm).toBeUndefined()
    expect(w4.measureBy).toBeUndefined()

    const earring = legacyBatchToSandboxTemporaryBatch({
      ...base, productType: 'earring', imageFiles: ['E1.png', 'E2.png'], earringTypes: { e1: 'hoop' },
    })
    expect(earring.images[0]).toMatchObject({ sku: 'E1', productType: 'earring', earringType: 'hoop' })
    expect(earring.images[1].earringType).toBeUndefined()

    for (const product of ['ring', 'bracelet'] as const) {
      const rb = legacyBatchToSandboxTemporaryBatch({ ...base, productType: product, imageFiles: ['X.webp'] })
      expect(rb.productTypes).toEqual([product])
      expect(rb.images[0]).toEqual({ sku: 'X', imagePath: join(base.sourceDir, 'X.webp'), productType: product })
    }

    // Duplicate SKU (a.png + a.jpg) — first wins, not processed twice.
    const dup = legacyBatchToSandboxTemporaryBatch({ ...base, productType: 'ring', imageFiles: ['a.jpg', 'A.png'] })
    expect(dup.images.map(i => i.sku)).toEqual(['a'])
  })

  it('D. end to end from the registry: a Watch Legacy batch pulls widthMm/measureBy from its own spreadsheet, an Earring batch its classification from its own metadata sheet', async () => {
    const watchDir = join(scratchDir, 'src', 'watch')
    await mkdir(watchDir, { recursive: true })
    await png(join(watchDir, 'WATCH-1.png'))
    await png(join(watchDir, 'WATCH-2.png'))
    const sheet = join(scratchDir, 'watch.csv')
    await writeFile(sheet, 'SKU,Width,Height,Measure By\nwatch-1,42,50,Case\nWATCH-2,30,35,Dial\n')
    const watchBatch = await makeLegacyBatch({ title: 'W', sourceDir: watchDir, stage: 'watch', config: { spreadsheetPath: sheet } })

    const earDir = join(scratchDir, 'src', 'ear')
    await mkdir(earDir, { recursive: true })
    await png(join(earDir, 'EAR-1.png'))
    await png(join(earDir, 'EAR-2.png'))
    const meta = join(scratchDir, 'ear.csv')
    await writeFile(meta, 'SKU,Category,Sub-Category,Dimensions\nEAR-1,Earrings,Hoops,10x10\nEAR-2,Earrings,Gizmo,10x10\n')
    const earBatch = await makeLegacyBatch({ title: 'E', sourceDir: earDir, stage: 'editing', config: { product: 'earring', metadataPath: meta } })

    const { getLocalTestBatchDetail } = await import('../apps/desktop/electron/sandbox/localLegacyBatchSource')
    const w = await getLocalTestBatchDetail(`local-legacy:${watchBatch.id}`)
    expect(w!.productTypes).toEqual(['watch'])
    expect(w!.images).toEqual([
      { sku: 'WATCH-1', imagePath: join(watchDir, 'WATCH-1.png'), productType: 'watch', widthMm: 42, heightMm: 50, measureBy: 'Case' },
      { sku: 'WATCH-2', imagePath: join(watchDir, 'WATCH-2.png'), productType: 'watch', widthMm: 30, heightMm: 35, measureBy: 'Dial' },
    ])

    const e = await getLocalTestBatchDetail(`local-legacy:${earBatch.id}`)
    expect(e!.images[0]).toMatchObject({ sku: 'EAR-1', earringType: 'hoop' })
    expect(e!.images[1].earringType).toBeUndefined() // unmapped Sub-Category stays unclassified
  })

  it('C. selecting/adapting a Legacy batch never modifies its persisted representation or its source folder', async () => {
    const dir = join(scratchDir, 'src', 'ring')
    await mkdir(dir, { recursive: true })
    await png(join(dir, 'R1.png'))
    const batch = await makeLegacyBatch({ title: 'R', sourceDir: dir, stage: 'editing', config: { product: 'ring' } })

    const before = await snapshotRegistry()
    const filesBefore = (await readdir(dir)).sort()
    const bytesBefore = await readFile(join(dir, 'R1.png'))

    const { listLocalTestBatches, getLocalTestBatchDetail } = await import('../apps/desktop/electron/sandbox/localLegacyBatchSource')
    const { resolveTemporaryBatchDetail } = await import('../apps/desktop/electron/sandbox/temporaryBatchResolver')
    await listLocalTestBatches()
    await getLocalTestBatchDetail(`local-legacy:${batch.id}`)
    await resolveTemporaryBatchDetail(`local-legacy:${batch.id}`)

    expect(await snapshotRegistry()).toEqual(before)
    expect((await readdir(dir)).sort()).toEqual(filesBefore)
    expect((await readFile(join(dir, 'R1.png'))).equals(bytesBefore)).toBe(true)
  })

  it('E. path safety: ids are resolved only via the registry (unknown/forged ids and non-local ids return null), Sandbox-owned batches are never offered, and source paths stay inside the source folder', async () => {
    const { getLocalTestBatchDetail, listLocalTestBatches, legacyBatchToSandboxTemporaryBatch } = await import(
      '../apps/desktop/electron/sandbox/localLegacyBatchSource'
    )
    expect(await getLocalTestBatchDetail('local-legacy:../../etc/passwd')).toBeNull()
    expect(await getLocalTestBatchDetail('local-legacy:batch-does-not-exist')).toBeNull()
    expect(await getLocalTestBatchDetail('mock-temp-batch-1')).toBeNull()

    // A Legacy batch that is really a Sandbox run's own workspace batch.
    const sandboxSource = join(scratchDir, 'userData', 'sandbox-runs', 'run-1', 'workspace', 'ring', 'source')
    await mkdir(sandboxSource, { recursive: true })
    await png(join(sandboxSource, 'R.png'))
    const owned = await makeLegacyBatch({ title: 'Sandbox — x — ring', sourceDir: sandboxSource, stage: 'editing', config: { product: 'ring' } })
    expect(await getLocalTestBatchDetail(`local-legacy:${owned.id}`)).toBeNull()
    const listed = await listLocalTestBatches()
    expect(listed.batches.find(b => b.name.startsWith('Sandbox'))).toBeUndefined()
    expect(listed.hidden.find(h => h.name.startsWith('Sandbox'))).toBeUndefined()

    // Every produced path is inside the source folder (existing safety check).
    const sourceDir = join(scratchDir, 'src', 'ring')
    const detail = legacyBatchToSandboxTemporaryBatch({
      legacyBatchId: 'b', name: 'n', productType: 'ring', sourceDir, imageFiles: ['ok.png'],
    })
    expect(detail.images.every(i => i.imagePath.startsWith(sourceDir))).toBe(true)
    expect(() =>
      legacyBatchToSandboxTemporaryBatch({ legacyBatchId: 'b', name: 'n', productType: 'ring', sourceDir, imageFiles: ['../escape.png'] }),
    ).toThrow(/outside the Sandbox workspace/)
  })

  it(
    'F. integration: real Legacy batch -> local adapter -> SandboxTemporaryBatch -> real Sandbox config -> real SandboxRun, leaving the Legacy batch and its source untouched',
    async () => {
      const dir = join(scratchDir, 'src', 'ring')
      await mkdir(dir, { recursive: true })
      await png(join(dir, 'RING-A.png'), 160)
      await png(join(dir, 'RING-B.png'), 160)
      const legacy = await makeLegacyBatch({ title: 'Quick Ring Test', sourceDir: dir, stage: 'editing', config: { product: 'ring' } })

      const registryBefore = (await snapshotRegistry())[`${legacy.id}.json`]
      const sourceBefore = (await readdir(dir)).sort()

      const { listLocalTestBatches } = await import('../apps/desktop/electron/sandbox/localLegacyBatchSource')
      const { resolveTemporaryBatchDetail } = await import('../apps/desktop/electron/sandbox/temporaryBatchResolver')
      const { startSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxOrchestrator')
      const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
      const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')

      const [summary] = (await listLocalTestBatches()).batches
      expect(summary.name).toBe('Quick Ring Test')
      const batch = (await resolveTemporaryBatchDetail(summary.id))!
      expect(batch.imageCount).toBe(2)

      const config = createInitialUniversalConfig(batch)
      config.preprocessing.operation = 'none'
      const started = await startSandboxRun(batch, config)
      expect(started.ok).toBe(true)

      let run: any
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        run = await getSandboxRun(started.runId!)
        if (run && ['completed', 'partially_completed', 'failed', 'cancelled'].includes(run.status)) break
        await new Promise(r => setTimeout(r, 100))
      }
      expect(run.status).toBe('completed')
      expect(run.temporaryBatchId).toBe(summary.id)
      expect(run.pipelines[0].productType).toBe('ring')
      // Sandbox processed its OWN workspace copy...
      expect(existsSync(run.pipelines[0].postProcessingOutputDir)).toBe(true)
      expect(run.pipelines[0].postProcessingOutputDir).toContain(join('userData', 'sandbox-runs', started.runId!))
      // ...and re-entering later still resolves the same local batch by id (reload/resume + Final Review path).
      expect((await resolveTemporaryBatchDetail(run.temporaryBatchId))!.images.map(i => i.sku)).toEqual(['RING-A', 'RING-B'])

      // The source Legacy batch record and source folder are byte-identical.
      expect((await snapshotRegistry())[`${legacy.id}.json`]).toBe(registryBefore)
      expect((await readdir(dir)).sort()).toEqual(sourceBefore)

      // The Legacy batches Sandbox itself created are never offered back as a source.
      expect((await listLocalTestBatches()).batches.map(b => b.name)).toEqual(['Quick Ring Test'])
    },
    90000,
  )
})
