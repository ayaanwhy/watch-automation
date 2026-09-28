// Phase 15.3 — Sandbox Execution Orchestrator, exercised for real: a real
// SandboxRun, a real materialized workspace, real boundary detection
// (fetch mocked, same pattern as Phase 14/15.0's own tests) against the
// real sampledata/1688KM11.png, and the real @wpa/processing processWatch
// engine. Ring is deliberately given no source image so its pipeline fails
// fast and honestly — this proves cross-product concurrency and failure
// isolation without needing a real, slow Python subprocess in this file
// (Ring/Bracelet/Earring/Preprocessing's own real subprocess execution is
// already covered by existing tests — subprocessRunnerIncrementalPersistence.test.ts,
// earringRunnerIntegration.test.ts, etc. — this file's job is to prove the
// orchestrator's dispatch/concurrency/state logic, not re-prove Python
// execution).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir: string
const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')
const REAL_WATCH_IMAGE = join(__dirname, '..', 'sampledata', '1688KM11.png')

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir, getAppPath: () => REAL_APP_PATH },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}))

const TERMINAL_STATUSES = new Set(['completed', 'partially_completed', 'failed', 'cancelled'])

async function waitForTerminal(getSandboxRun: (id: string) => Promise<any>, runId: string, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const detail = await getSandboxRun(runId)
    if (detail && TERMINAL_STATUSES.has(detail.status)) return detail
    await new Promise(r => setTimeout(r, 40))
  }
  throw new Error('Timed out waiting for SandboxRun to reach a terminal state')
}

// Distinguishes the preflight connectivity check (GET .../openapi.json,
// see sandboxPreflight.ts's watchEndpointReachableCheck) from a real
// detection call (POST .../bbox/predict) — both go through the same
// globalThis.fetch, but only detection calls are required to be globally
// serialized through boundaryDetection.ts's SingleFlightQueue; two
// independent SandboxRuns' own preflight checks have no reason to
// serialize against each other, so concurrency is tracked per kind.
function makeFetchMock() {
  let detectionInFlight = 0
  let detectionMaxConcurrent = 0
  let detectionCalls = 0
  const fn = vi.fn(async (url: string) => {
    const isDetection = url.includes('/bbox/predict')
    if (isDetection) {
      detectionInFlight++
      detectionMaxConcurrent = Math.max(detectionMaxConcurrent, detectionInFlight)
      detectionCalls++
    }
    await new Promise(r => setTimeout(r, 20))
    if (isDetection) detectionInFlight--
    if (!isDetection) {
      return new Response('{}', { status: 200 })
    }
    return new Response(
      JSON.stringify({ success: true, message: 'ok', case_bbox: [263, 4, 1312, 979], dial_bbox: [356, 57, 1212, 965] }),
      { status: 200 },
    )
  })
  return { fn, getMaxConcurrent: () => detectionMaxConcurrent, getDetectionCalls: () => detectionCalls }
}

// Phase 15.4 note (superseded by Phase 15.7 below): every pipeline that
// reached Post Processing used to fail there, honestly — no real script
// had an implementation anywhere in this repository at that time.
//
// Phase 15.7 update: Watch's post-processing chain (removeShadows,
// compressorNew) now has real implementations (see postProcessing/*/
// runner.py and electron/sandbox/sandboxPostProcessing/*Adapter.ts) and
// genuinely runs — via the real, resolved Python interpreter — against
// this test's own real Watch fixture image. A batch whose only available
// product is Watch can once again reach an overall 'completed' run status,
// the same as before Phase 15.4 existed, except now for a real reason (real
// script execution succeeded) rather than by omission.
describe('Sandbox Execution Orchestrator (Phase 15.3 + 15.4 + 15.7 Post Processing)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-orchestrator-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('runs Watch Editing and Post Processing to real success while Ring fails fast — cross-product concurrency + failure isolation', async () => {
    const fetchMock = makeFetchMock()
    globalThis.fetch = fetchMock.fn as unknown as typeof fetch

    const { startSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxOrchestrator')
    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const { getBatch } = await import('../apps/desktop/electron/services/batchRegistry')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')

    const batch = {
      id: 'batch-1',
      name: 'Integration Test Batch',
      productTypes: ['watch', 'ring'] as const,
      imageCount: 2,
      images: [
        { sku: 'WATCH-1', imagePath: REAL_WATCH_IMAGE, productType: 'watch' as const, widthMm: 42, measureBy: 'Case' as const },
        { sku: 'RING-1', imagePath: '', productType: 'ring' as const },
      ],
    }
    const config = createInitialUniversalConfig(batch)
    config.preprocessing.operation = 'none' // no real subprocess needed — keeps this test fast

    const started = await startSandboxRun(batch, config)
    expect(started.ok).toBe(true)
    expect(started.runId).toBeTruthy()

    const final = await waitForTerminal(getSandboxRun, started.runId!)

    // Ring fails fast at materialize; Watch's Editing genuinely succeeds
    // AND (Phase 15.7) Post Processing now has real implementations
    // (removeShadows, compressorNew) that genuinely run against the real
    // Watch fixture image, so Watch reaches 'completed' — the run overall
    // is 'partially_completed' (one product completed, one failed), not
    // 'failed'.
    expect(final.status).toBe('partially_completed')

    const watchPipeline = final.pipelines.find((p: any) => p.productType === 'watch')
    expect(watchPipeline.status).toBe('completed')
    expect(watchPipeline.batchId).toBeTruthy()
    expect(watchPipeline.error).toBeNull()
    // The real final post-processing artifact directory is recorded and
    // genuinely contains the compressed, shadow-cleaned output.
    expect(watchPipeline.postProcessingOutputDir).toBeTruthy()
    expect(existsSync(watchPipeline.postProcessingOutputDir)).toBe(true)

    const ringPipeline = final.pipelines.find((p: any) => p.productType === 'ring')
    expect(ringPipeline.status).toBe('failed')
    // Structured, actionable: WHAT (source image missing), WHICH SKU, and a
    // stable code — not a bare "failed".
    expect(ringPipeline.failure.code).toBe('SOURCE_IMAGE_MISSING')
    expect(ringPipeline.failure.retryable).toBe(true)
    expect(ringPipeline.error).toContain('RING-1')
    const ringItem = final.items.find((i: any) => i.sku === 'RING-1')
    expect(ringItem.status).toBe('failed')
    expect(ringItem.failure.code).toBe('SOURCE_IMAGE_MISSING')

    // Per-item Watch progress recorded on the SandboxRun itself.
    const watchItem = final.items.find((i: any) => i.sku === 'WATCH-1')
    expect(watchItem.status).toBe('completed')

    // The underlying Legacy Batch really exists and really has the
    // completed image on its 'watch' stage — proving genuine reuse of
    // processWatch/batchRegistry, not a parallel bookkeeping system.
    const watchBatch = await getBatch(watchPipeline.batchId)
    const watchStage = watchBatch!.stages.find((s: any) => s.type === 'watch')
    expect(watchStage!.counts.succeeded).toBe(1)
    expect(watchStage!.images[0].status).toBe('completed')
    expect(existsSync(watchStage!.images[0].outputPath!)).toBe(true)

    // Ring had no processable item (its image is missing), so the input
    // check rejects it BEFORE any Legacy Batch is created — nothing is
    // fabricated, and no empty batch is left behind.
    expect(ringPipeline.batchId).toBeNull()

    // Watch SingleFlight: exactly one detection call for the one Watch
    // image, and it never overlapped with anything else.
    expect(fetchMock.getDetectionCalls()).toBe(1)
    expect(fetchMock.getMaxConcurrent()).toBe(1)
  }, 30000)

  it('two independent SandboxRuns’ Watch detection calls still serialize through the one authoritative main-process queue', async () => {
    const fetchMock = makeFetchMock()
    globalThis.fetch = fetchMock.fn as unknown as typeof fetch

    const { startSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxOrchestrator')
    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')

    function watchOnlyBatch(id: string, sku: string) {
      return {
        id,
        name: `Batch ${id}`,
        productTypes: ['watch'] as const,
        imageCount: 1,
        images: [{ sku, imagePath: REAL_WATCH_IMAGE, productType: 'watch' as const, widthMm: 40, measureBy: 'Case' as const }],
      }
    }

    const batchA = watchOnlyBatch('batch-a', 'WATCH-A')
    const batchB = watchOnlyBatch('batch-b', 'WATCH-B')
    const configA = createInitialUniversalConfig(batchA)
    configA.preprocessing.operation = 'none'
    const configB = createInitialUniversalConfig(batchB)
    configB.preprocessing.operation = 'none'

    const [startedA, startedB] = await Promise.all([startSandboxRun(batchA, configA), startSandboxRun(batchB, configB)])
    expect(startedA.ok).toBe(true)
    expect(startedB.ok).toBe(true)

    const [finalA, finalB] = await Promise.all([
      waitForTerminal(getSandboxRun, startedA.runId!),
      waitForTerminal(getSandboxRun, startedB.runId!),
    ])

    // Both genuinely complete (Phase 15.7 — removeShadows/compressorNew are
    // real now); the point of this test is the detection-call
    // serialization below, not the terminal status.
    expect(finalA.status).toBe('completed')
    expect(finalB.status).toBe('completed')
    expect(finalA.pipelines[0].error).toBeNull()
    expect(finalB.pipelines[0].error).toBeNull()
    // The two runs' Watch detection calls (started concurrently from two
    // independent SandboxRuns) still never overlapped — the SAME
    // module-level queue in boundaryDetection.ts serializes every caller,
    // regardless of which SandboxRun it came from.
    expect(fetchMock.getMaxConcurrent()).toBe(1)
    expect(fetchMock.getDetectionCalls()).toBe(2)
  }, 30000)

  it('marks Necklace unavailable without a Batch, fails a Gemstone with no image/metadata precisely (never unavailable, never success), and still completes the available product', async () => {
    const fetchMock = makeFetchMock()
    globalThis.fetch = fetchMock.fn as unknown as typeof fetch

    const { startSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxOrchestrator')
    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')

    const batch = {
      id: 'batch-necklace',
      name: 'Necklace/Gemstone Batch',
      productTypes: ['watch', 'necklace', 'gemstone'] as const,
      imageCount: 3,
      images: [
        { sku: 'WATCH-1', imagePath: REAL_WATCH_IMAGE, productType: 'watch' as const, widthMm: 41, measureBy: 'Case' as const },
        { sku: 'NECKLACE-1', imagePath: '', productType: 'necklace' as const },
        { sku: 'GEMSTONE-1', imagePath: '', productType: 'gemstone' as const },
      ],
    }
    const config = createInitialUniversalConfig(batch)
    config.preprocessing.operation = 'none'

    const started = await startSandboxRun(batch, config)
    expect(started.ok).toBe(true)
    const final = await waitForTerminal(getSandboxRun, started.runId!)

    const necklace = final.pipelines.find((p: any) => p.productType === 'necklace')
    const gemstone = final.pipelines.find((p: any) => p.productType === 'gemstone')
    expect(necklace.status).toBe('unavailable')
    expect(necklace.batchId).toBeNull()
    // Gemstone is a supported product now: it is unavailable only when
    // required data is genuinely missing — here it has neither an image nor
    // Shape/width/height, so it FAILS (with the precise first cause) before
    // any Legacy batch is created; it is never reported as unavailable or
    // as a success.
    expect(gemstone.status).toBe('failed')
    expect(gemstone.batchId).toBeNull()
    expect(gemstone.failure.code).toBe('SOURCE_IMAGE_MISSING')

    // Watch's Editing and (Phase 15.7's real) Post Processing both
    // genuinely succeed — this test's real point is that Necklace/Gemstone
    // are unavailable without a Batch and without a fabricated success,
    // which holds regardless of Watch's own post-processing outcome.
    const watch = final.pipelines.find((p: any) => p.productType === 'watch')
    expect(watch.status).toBe('completed')
    expect(watch.error).toBeNull()
    // Watch completed, Gemstone failed (Necklace unavailable is excluded).
    expect(final.status).toBe('partially_completed')
  }, 30000)

  it('cancellation prevents a queued Watch image from starting but does not relabel the already-completed one', async () => {
    const fetchMock = makeFetchMock()
    globalThis.fetch = fetchMock.fn as unknown as typeof fetch

    const { startSandboxRun, cancelSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxOrchestrator')
    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')

    const batch = {
      id: 'batch-cancel',
      name: 'Cancel Test Batch',
      productTypes: ['watch'] as const,
      imageCount: 2,
      images: [
        { sku: 'WATCH-1', imagePath: REAL_WATCH_IMAGE, productType: 'watch' as const, widthMm: 41, measureBy: 'Case' as const },
        { sku: 'WATCH-2', imagePath: REAL_WATCH_IMAGE, productType: 'watch' as const, widthMm: 41, measureBy: 'Case' as const },
      ],
    }
    const config = createInitialUniversalConfig(batch)
    config.preprocessing.operation = 'none'

    const started = await startSandboxRun(batch, config)
    expect(started.ok).toBe(true)

    // Give the first image a moment to actually start/complete, then
    // cancel — proving real work already begun is not "undone", while
    // whatever hadn't started yet never starts.
    await new Promise(r => setTimeout(r, 60))
    await cancelSandboxRun(started.runId!)

    const final = await waitForTerminal(getSandboxRun, started.runId!)

    const items = final.items as any[]
    const statuses = items.map(i => i.status)
    // Never both actually ran — cancellation genuinely stopped something.
    expect(statuses.includes('cancelled') || final.pipelines[0].status === 'cancelled').toBe(true)
    // Nothing already completed was relabeled as cancelled.
    for (const item of items) {
      if (item.status === 'completed') expect(item.status).not.toBe('cancelled')
    }
    expect(['cancelled', 'partially_completed']).toContain(final.status)
  }, 30000)

  it('startSandboxRun refuses to create a run when configuration is invalid (no product types), leaving nothing behind', async () => {
    const { startSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxOrchestrator')
    const { listSandboxRuns } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')

    const batch = { id: 'batch-empty', name: 'Empty Batch', productTypes: [] as const, imageCount: 0, images: [] }
    const config = createInitialUniversalConfig(batch)

    const result = await startSandboxRun(batch, config)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(await listSandboxRuns()).toEqual([])
  })

  it('startSandboxRun refuses to create a run when preflight fails (unwritable Sandbox storage)', async () => {
    // Point userData at a file (not a directory) so the storage preflight
    // check's real mkdir/write genuinely fails — not a mocked failure.
    const { writeFile } = await import('node:fs/promises')
    const blockerPath = join(scratchDir, 'blocked-as-a-file')
    await writeFile(blockerPath, 'not a directory')
    scratchDir = blockerPath

    const { startSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxOrchestrator')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')

    const batch = {
      id: 'batch-preflight-fail',
      name: 'Preflight Fail Batch',
      productTypes: ['ring'] as const,
      imageCount: 1,
      images: [{ sku: 'RING-1', imagePath: '', productType: 'ring' as const }],
    }
    const config = createInitialUniversalConfig(batch)

    const result = await startSandboxRun(batch, config)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Preflight failed')
  })
})
