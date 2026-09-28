// The Automation Engine exercised through its interface ONLY — no React, no
// Electron window, no IPC handler: createJob / startJob / subscribeToJobProgress
// / getJobState / cancelJob / getJobArtifacts / recoverInterruptedJobs, with
// real Python runners and real post-processing. Proves the core execution
// layer runs (and streams live, persisted progress) without any Sandbox UI
// component existing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
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

async function ringImage(path: string) {
  const w = 220, h = 160
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot((x - w / 2) / (w * 0.35), (y - h / 2) / (h * 0.35))
    const i = (y * w + x) * 4
    buf[i] = 180; buf[i + 1] = 150; buf[i + 2] = 80; buf[i + 3] = d > 0.6 && d < 1 ? 255 : 0
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path)
}

async function waitForState(engine: any, id: string, done: (s: any) => boolean, timeoutMs = 90000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const s = await engine.getJobState(id)
    if (s && done(s)) return s
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('timed out')
}
const TERMINAL = ['completed', 'partially_completed', 'failed', 'cancelled']

describe('Automation Engine — driven without any UI', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-engine-boundary-'))
    vi.resetModules()
  })
  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  async function fixtures(n: number) {
    await mkdir(join(scratchDir, 'fx'), { recursive: true })
    const paths: string[] = []
    for (let i = 0; i < n; i++) {
      const p = join(scratchDir, 'fx', `img${i}.png`)
      await ringImage(p)
      paths.push(p)
    }
    return paths
  }

  it(
    'streams live structured progress for concurrent products, persists it as the source of truth, and never regresses a finished image',
    async () => {
      const [a, b, c, d] = await fixtures(4)
      const batch = {
        id: 'engine-batch',
        name: 'Engine Batch',
        productTypes: ['ring', 'bracelet', 'necklace'] as any,
        imageCount: 5,
        images: [
          { sku: 'R-1', imagePath: a, productType: 'ring' },
          { sku: 'R-2', imagePath: b, productType: 'ring' },
          { sku: 'B-1', imagePath: c, productType: 'bracelet' },
          { sku: 'B-2', imagePath: d, productType: 'bracelet' },
          { sku: 'N-1', imagePath: '', productType: 'necklace' },
        ],
      } as any

      const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
      const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
      const config = createInitialUniversalConfig(batch)
      config.preprocessing.operation = 'none'

      const events: any[] = []
      const unsubscribe = automationEngine.subscribeToJobProgress(s => events.push(structuredClone(s)))

      // createJob persists the full per-image plan BEFORE anything runs.
      const created = await automationEngine.createJob(batch, config)
      expect(created.ok).toBe(true)
      const jobId = created.runId!
      const planned = await automationEngine.getJobState(jobId)
      expect(planned!.status).toBe('draft')
      const plannedRing = planned!.items.find((i: any) => i.sku === 'R-1')
      expect(plannedRing.status).toBe('queued')
      expect(plannedRing.stages.map((s: any) => s.label)).toEqual(['Ring Editing', 'imageResizeNew', 'compressorNew', 'makeCompareRB'])
      expect(planned!.items.find((i: any) => i.sku === 'N-1').status).toBe('unavailable')
      expect(events).toHaveLength(0) // nothing published, nothing running yet

      expect((await automationEngine.startJob(jobId)).ok).toBe(true)
      expect((await automationEngine.startJob(jobId)).ok).toBe(false) // can't start twice

      const final = await waitForState(automationEngine, jobId, s => TERMINAL.includes(s.status))
      unsubscribe()
      expect(final.status).toBe('completed')
      expect(final.startedAt).toBeTruthy()
      expect(final.finishedAt).toBeTruthy()

      // Events are FULL persisted states, in order, ending at exactly the persisted truth.
      const mine = events.filter(e => e.id === jobId)
      expect(mine.length).toBeGreaterThan(5)
      for (let i = 1; i < mine.length; i++) expect(mine[i].updatedAt >= mine[i - 1].updatedAt).toBe(true)
      const last = mine[mine.length - 1]
      expect(last.status).toBe('completed')
      expect(last.items).toEqual(final.items)

      // Concurrent products: both were 'running' at the same time in at least one event.
      expect(mine.some(e => e.pipelines.filter((p: any) => p.status === 'running').length >= 2)).toBe(true)
      // Live per-image progress was actually reported (not just a final state).
      expect(mine.some(e => e.items.some((i: any) => i.status === 'running'))).toBe(true)
      // Batch-global post-processing is reported as such — never a percentage.
      const activities = mine.flatMap(e => e.pipelines.map((p: any) => p.activity)).filter(Boolean)
      expect(activities.some((a: string) => /^Running \w+ — batch post-processing$/.test(a))).toBe(true)
      expect(JSON.stringify(mine)).not.toMatch(/percent/i)

      // A finished image is never relabelled by any later event.
      const seen = new Map<string, string>()
      for (const e of mine) {
        for (const i of e.items) {
          const key = `${i.productType}:${i.sku}`
          const prior = seen.get(key)
          if (prior && ['completed', 'failed', 'cancelled', 'unavailable'].includes(prior)) expect(i.status, key).toBe(prior)
          seen.set(key, i.status)
        }
      }

      // Final per-image state: every ring/bracelet image completed with all stages done; necklace stays unavailable.
      for (const i of final.items.filter((x: any) => x.productType !== 'necklace')) {
        expect(i.status).toBe('completed')
        expect(i.stages.every((s: any) => s.status === 'done')).toBe(true)
        expect(i.failure).toBeNull()
      }
      expect(final.items.find((i: any) => i.sku === 'N-1')).toMatchObject({ status: 'unavailable', failure: null })

      // Artifacts through the interface: final dirs only for completed products.
      const artifacts = await automationEngine.getJobArtifacts(jobId)
      for (const p of artifacts!.products) {
        if (p.status === 'completed') expect(existsSync(p.finalArtifactDir!)).toBe(true)
        else expect(p.finalArtifactDir).toBeNull()
      }
      expect(artifacts!.products.find(p => p.productType === 'necklace')!.finalArtifactDir).toBeNull()

      // "Renderer reload / service restart": a fresh module graph sees the identical persisted job,
      // and recovery leaves finished jobs alone.
      vi.resetModules()
      const reloaded = (await import('../apps/desktop/electron/sandbox/engine/automationEngine')).automationEngine
      expect(await reloaded.getJobState(jobId)).toEqual(final)
      expect(await reloaded.recoverInterruptedJobs()).toEqual([])
      expect((await reloaded.listJobs()).map(j => j.id)).toContain(jobId)
    },
    120000,
  )

  it('recoverInterruptedJobs records a job left in flight by a dead engine truthfully — completed work is never relabelled, nothing is resumed or duplicated', async () => {
    const { createSandboxRun, updateSandboxRun, getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
    const run = await createSandboxRun({ title: 'orphan', temporaryBatchId: 'x', productTypes: ['ring', 'bracelet'], universalConfig: {} })
    const stage = (status: string) => [{ id: 'editing', label: 'Ring Editing', phase: 'editing', status }]
    await updateSandboxRun(run.id, {
      status: 'running',
      pipelines: run.pipelines.map(p => ({ ...p, status: p.productType === 'ring' ? 'completed' : 'running' })) as any,
      items: [
        { sku: 'DONE', productType: 'ring', status: 'completed', error: null, stages: stage('done') },
        { sku: 'MID', productType: 'bracelet', status: 'running', error: null, stages: stage('running'), stage: 'Ring Editing' },
        { sku: 'WAIT', productType: 'bracelet', status: 'queued', error: null, stages: stage('pending') },
      ] as any,
    })
    const draft = await createSandboxRun({ title: 'never started', temporaryBatchId: 'y', productTypes: ['ring'], universalConfig: {} })

    const updates: any[] = []
    automationEngine.subscribeToJobProgress(s => updates.push(s))
    const recovered = await automationEngine.recoverInterruptedJobs()
    expect(recovered.sort()).toEqual([run.id, draft.id].sort())

    const after = (await getSandboxRun(run.id))!
    expect(after.status).toBe('failed')
    expect(after.failure).toMatchObject({ code: 'RUN_INTERRUPTED', retryable: true })
    expect(after.finishedAt).toBeTruthy()
    const byResult = Object.fromEntries(after.items.map(i => [i.sku, i]))
    expect(byResult.DONE.status).toBe('completed') // untouched
    expect(byResult.MID).toMatchObject({ status: 'failed', failure: { code: 'RUN_INTERRUPTED', sku: 'MID' } })
    expect(byResult.WAIT.status).toBe('failed')
    expect(after.pipelines.find(p => p.productType === 'ring')!.status).toBe('completed')
    expect(after.pipelines.find(p => p.productType === 'bracelet')).toMatchObject({ status: 'failed', failure: { code: 'RUN_INTERRUPTED' } })
    // A run that never started is cancelled (nothing was lost), not "failed".
    expect((await getSandboxRun(draft.id))!.status).toBe('cancelled')
    expect(updates.length).toBeGreaterThan(0) // recovery is published like any state change
    // Idempotent: nothing left to recover.
    expect(await automationEngine.recoverInterruptedJobs()).toEqual([])
  })

  it('createJob refuses (creating nothing) when no item could possibly run, reporting the precise cause', async () => {
    const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const [img] = await fixtures(1)
    const batch = { id: 'g', name: 'Gems', productTypes: ['gemstone'], imageCount: 1, images: [{ sku: 'G-1', imagePath: img, productType: 'gemstone', widthMm: 6, heightMm: 4 }] } as any
    const result = await automationEngine.createJob(batch, createInitialUniversalConfig(batch))
    expect(result.ok).toBe(false)
    expect(result.failure).toMatchObject({ code: 'MISSING_GEMSTONE_SHAPE', sku: 'G-1', retryable: false })
    expect(result.failure!.action).toMatch(/Shape/)
    expect(await automationEngine.listJobs()).toEqual([])
  })

  it('duplicate SKUs are planned as failed (SKU_DUPLICATE) while the first occurrence still runs', async () => {
    const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const [img] = await fixtures(1)
    const batch = { id: 'd', name: 'Dup', productTypes: ['ring'], imageCount: 2, images: [{ sku: 'X', imagePath: img, productType: 'ring' }, { sku: 'x', imagePath: img, productType: 'ring' }] } as any
    const created = await automationEngine.createJob(batch, createInitialUniversalConfig(batch))
    const state = await automationEngine.getJobState(created.runId!)
    expect(state!.items.map((i: any) => [i.sku, i.status, i.failure?.code ?? null])).toEqual([['X', 'queued', null], ['x', 'failed', 'SKU_DUPLICATE']])
  })

  it(
    'cancelJob reaches the in-flight subprocess job cooperatively: nothing is left mid-flight, finished images keep their state, no image is relabelled',
    async () => {
      const paths = await fixtures(6)
      const batch = {
        id: 'cx', name: 'Cancel', productTypes: ['ring'], imageCount: 6,
        images: paths.map((p, i) => ({ sku: `C-${i}`, imagePath: p, productType: 'ring' })),
      } as any
      const { automationEngine } = await import('../apps/desktop/electron/sandbox/engine/automationEngine')
      const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
      const config = createInitialUniversalConfig(batch)
      config.preprocessing.operation = 'none'

      const events: any[] = []
      automationEngine.subscribeToJobProgress(s => events.push(structuredClone(s)))
      const submitted = await automationEngine.submitJob(batch, config)
      const id = submitted.runId!

      // Cancel as soon as editing is genuinely under way.
      await waitForState(automationEngine, id, s => s.pipelines[0].stage === 'editing')
      expect((await automationEngine.cancelJob(id)).ok).toBe(true)
      const final = await waitForState(automationEngine, id, s => TERMINAL.includes(s.status))

      expect(['cancelled', 'partially_completed']).toContain(final.status)
      expect(final.cancelRequested).toBe(true)
      // No image is left non-terminal, and none is falsely marked failed by the cancellation.
      for (const i of final.items) {
        expect(['completed', 'cancelled']).toContain(i.status)
        expect(i.failure).toBeNull()
      }
      expect(final.items.some((i: any) => i.status === 'cancelled')).toBe(true)
      // Terminal states never regress across the whole event stream.
      const seen = new Map<string, string>()
      for (const e of events.filter(e => e.id === id)) for (const i of e.items) {
        const prior = seen.get(i.sku)
        if (prior && ['completed', 'failed', 'cancelled'].includes(prior)) expect(i.status).toBe(prior)
        seen.set(i.sku, i.status)
      }
      // Cancellation is recorded once, never as a failure at run level.
      expect(final.failure).toBeNull()
    },
    120000,
  )
})
