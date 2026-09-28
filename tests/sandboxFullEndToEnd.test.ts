// Final Sandbox hardening phase — one genuine, unbroken run through the
// ENTIRE approved flow using real execution at every stage (never a fully
// mocked orchestrator/review layer):
//
//   Temporary Batch -> Universal Config -> Preflight -> SandboxRun
//   -> real Preprocessing -> real product Editing -> real Post Processing
//   -> real Final Review item assembly -> real Approve (+ real QA handoff)
//   -> real Reject (+ real Manual Editor handoff)
//   -> simulated reload -> persistence survives
//
// Exercises Watch (the one real photographic fixture this repo has —
// sampledata/1688KM11.png), Ring, Bracelet, and Earring (synthetic-but-real
// fixtures, same convention as subprocessRunnerIncrementalPersistence.test.ts/
// earringRunnerIntegration.test.ts — this repo has no real photographed
// Ring/Bracelet/Earring sample anywhere, an honest, pre-existing gap, not
// filled with a fabricated "real" asset), plus Necklace (deliberately
// unavailable, proving it's never silently treated as successful).
//
// Only ONE thing is stubbed: MockSandboxApiClient.getTemporaryBatchDetail,
// via vi.spyOn on the REAL singleton — its fixed fixture batches
// (sandboxApiClient.ts) have no real/synthetic image paths for Ring/
// Bracelet/Earring (documented there as an honest gap too), so a batch
// with this test's own synthetic fixtures can't be one of its hardcoded
// ids. Every other sandboxApiClient method (listEditors,
// handoffApprovedToQa, handoffRejectedToManualEditor) runs as the REAL
// MockSandboxApiClient implementation — approve/reject in this test
// genuinely records to its real, unmocked handoffLog.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

const TERMINAL_STATUSES = new Set(['completed', 'partially_completed', 'failed', 'cancelled'])

async function waitForTerminal(getSandboxRun: (id: string) => Promise<any>, runId: string, timeoutMs = 45000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const detail = await getSandboxRun(runId)
    if (detail && TERMINAL_STATUSES.has(detail.status)) return detail
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('Timed out waiting for SandboxRun to reach a terminal state')
}

// Same closed-ring-shape generator proven against the real Ring & Bracelet
// Python runner in subprocessRunnerIncrementalPersistence.test.ts.
async function writeSyntheticRingBraceletImage(path: string): Promise<void> {
  const width = 220
  const height = 160
  const buf = Buffer.alloc(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4
      const dx = (x - cx) / (width * 0.35)
      const dy = (y - cy) / (height * 0.35)
      const dist = Math.sqrt(dx * dx + dy * dy)
      const onRing = dist > 0.6 && dist < 1.0
      buf[idx] = 180
      buf[idx + 1] = 150
      buf[idx + 2] = 80
      buf[idx + 3] = onRing ? 255 : 0
    }
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

// Same symmetric-ellipse generator proven against the real Earring Python
// runner in earringRunnerIntegration.test.ts.
async function writeSyntheticEarringImage(path: string): Promise<void> {
  const width = 300
  const height = 220
  const buf = Buffer.alloc(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4
      const dx = (x - cx) / (width * 0.32)
      const dy = (y - cy) / (height * 0.4)
      const onShape = Math.sqrt(dx * dx + dy * dy) < 1.0
      buf[idx] = 140
      buf[idx + 1] = 100
      buf[idx + 2] = 60
      buf[idx + 3] = onShape ? 255 : 0
    }
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

describe('Sandbox full end-to-end — real execution through every stage', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-e2e-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(scratchDir, { recursive: true, force: true })
  })

  it(
    'Watch (Case) + Ring + Bracelet + Earring (stud) + unavailable Necklace, through real post-processing, real review, real approve+reject, and reload-survives persistence',
    async () => {
      const ringPath = join(scratchDir, 'fixtures', 'ring.png')
      const braceletPath = join(scratchDir, 'fixtures', 'bracelet.png')
      const earringPath = join(scratchDir, 'fixtures', 'earring.png')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(scratchDir, 'fixtures'), { recursive: true })
      await writeSyntheticRingBraceletImage(ringPath)
      await writeSyntheticRingBraceletImage(braceletPath)
      await writeSyntheticEarringImage(earringPath)

      const batch = {
        id: 'e2e-batch-1',
        name: 'End-to-End Test Batch',
        productTypes: ['watch', 'ring', 'bracelet', 'earring', 'necklace'] as const,
        imageCount: 5,
        images: [
          { sku: 'E2E-WATCH-1', imagePath: REAL_WATCH_IMAGE, productType: 'watch' as const, widthMm: 42, measureBy: 'Case' as const },
          { sku: 'E2E-RING-1', imagePath: ringPath, productType: 'ring' as const },
          { sku: 'E2E-BRACELET-1', imagePath: braceletPath, productType: 'bracelet' as const },
          { sku: 'E2E-EARRING-1', imagePath: earringPath, productType: 'earring' as const, earringType: 'stud' as const },
          { sku: 'E2E-NECKLACE-1', imagePath: '', productType: 'necklace' as const },
        ],
      }

      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/bbox/predict')) {
          return new Response(
            JSON.stringify({ success: true, message: 'ok', case_bbox: [263, 4, 1312, 979], dial_bbox: [356, 57, 1212, 965] }),
            { status: 200 },
          )
        }
        return new Response('{}', { status: 200 })
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const { startSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxOrchestrator')
      const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
      const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')

      const config = createInitialUniversalConfig(batch)
      config.preprocessing.operation = 'none' // preprocessing 'none' path — real, just fast

      // --- SandboxRun: preflight -> preprocessing -> editing -> post-processing ---
      const started = await startSandboxRun(batch, config)
      expect(started.ok).toBe(true)
      expect(started.runId).toBeTruthy()
      const runId = started.runId!

      const final = await waitForTerminal(getSandboxRun, runId)

      // Necklace: unavailable, never silently successful.
      const necklace = final.pipelines.find((p: any) => p.productType === 'necklace')
      expect(necklace.status).toBe('unavailable')
      expect(necklace.batchId).toBeNull()

      // Watch: real boundary detection (mocked HTTP) -> real processWatch ->
      // real post-processing (removeShadows + compressorNew).
      const watch = final.pipelines.find((p: any) => p.productType === 'watch')
      expect(watch.status).toBe('completed')
      expect(watch.postProcessingOutputDir).toBeTruthy()
      expect(existsSync(watch.postProcessingOutputDir)).toBe(true)
      expect(fetchMock.mock.calls.filter(c => String(c[0]).includes('/bbox/predict')).length).toBe(1)

      // Ring/Bracelet: real subprocess editing -> real imageResizeNew ->
      // compressorNew -> makeCompareRB chain.
      const ring = final.pipelines.find((p: any) => p.productType === 'ring')
      const bracelet = final.pipelines.find((p: any) => p.productType === 'bracelet')
      expect(ring.status).toBe('completed')
      expect(bracelet.status).toBe('completed')
      expect(existsSync(ring.postProcessingOutputDir)).toBe(true)
      const ringFinalFiles = await (await import('node:fs/promises')).readdir(ring.postProcessingOutputDir)
      expect(ringFinalFiles.some(f => f.includes(';compare'))).toBe(true)

      // Earring: real classification-driven subprocess dispatch -> real
      // compressorNew.
      const earring = final.pipelines.find((p: any) => p.productType === 'earring')
      expect(earring.status).toBe('completed')
      expect(existsSync(earring.postProcessingOutputDir)).toBe(true)

      // Necklace is 'unavailable', not 'failed' — it's excluded from the
      // run's own completion calculation (computeFinalStatus), so a run
      // where every AVAILABLE product genuinely completed is 'completed',
      // not dragged down to 'partially_completed' by an unavailable one.
      expect(final.status).toBe('completed')

      // --- Final Review: real item assembly against the real final artifacts ---
      const { sandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
      vi.spyOn(sandboxApiClient, 'getTemporaryBatchDetail').mockImplementation(async (id: string) =>
        id === batch.id ? (batch as any) : null,
      )

      const { getSandboxReviewItems, approveSandboxItems, rejectSandboxItems } = await import(
        '../apps/desktop/electron/sandbox/sandboxReviewService'
      )
      const items = await getSandboxReviewItems(runId)
      expect(items).not.toBeNull()

      const watchItem = items!.find(i => i.sku === 'E2E-WATCH-1')!
      const ringItem = items!.find(i => i.sku === 'E2E-RING-1')!
      const necklaceItem = items!.find(i => i.sku === 'E2E-NECKLACE-1')!

      // The final artifact is the POST-PROCESSING output, never the
      // pre-post-processing Editing path.
      expect(watchItem.outputPath).toContain(watch.postProcessingOutputDir)
      expect(ringItem.outputPath).toContain(ring.postProcessingOutputDir)
      // Necklace never got a real artifact — not reviewable, not disguised
      // as a success.
      expect(necklaceItem.outputPath).toBeNull()
      expect(necklaceItem.disposition.state).toBe('pending')

      const editors = await sandboxApiClient.listEditors()
      expect(editors.length).toBeGreaterThan(0)

      // --- Approve the Watch item -> real QA handoff ---
      const approveResult = await approveSandboxItems(runId, [{ productType: 'watch', sku: 'E2E-WATCH-1' }])
      expect(approveResult.ok).toBe(true)
      expect(approveResult.results['watch:E2E-WATCH-1']).toEqual({ ok: true })

      // --- Reject the Ring item -> real Manual Editor handoff ---
      const rejectResult = await rejectSandboxItems(runId, {
        keys: [{ productType: 'ring', sku: 'E2E-RING-1' }],
        reason: 'Crop needs adjustment',
        instructions: 'Please recenter',
        editor: editors[0],
      })
      expect(rejectResult.ok).toBe(true)

      // Necklace (never reviewable) cannot be approved — real disposition
      // logic refuses it, not the UI alone.
      const necklaceApprove = await approveSandboxItems(runId, [{ productType: 'necklace', sku: 'E2E-NECKLACE-1' }])
      expect(necklaceApprove.ok).toBe(false)
      expect(necklaceApprove.results['necklace:E2E-NECKLACE-1'].ok).toBe(false)

      // The REAL (unmocked) MockSandboxApiClient recorded both handoffs.
      const handoffLog = (sandboxApiClient as any).getHandoffLog()
      expect(handoffLog.some((e: any) => e.kind === 'qa' && e.payload.sku === 'E2E-WATCH-1')).toBe(true)
      expect(handoffLog.some((e: any) => e.kind === 'manual-editor' && e.payload.sku === 'E2E-RING-1')).toBe(true)
      // No raw arbitrary path structure leaked beyond real, already-produced
      // artifact paths — every ref is a string pointing at a file that
      // really exists inside this run's own workspace.
      const qaEntry = handoffLog.find((e: any) => e.kind === 'qa' && e.payload.sku === 'E2E-WATCH-1')
      expect(existsSync(qaEntry.payload.outputArtifactRef)).toBe(true)

      // --- Simulated reload: fresh module graph, only on-disk state remains ---
      vi.resetModules()
      const reimported = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
      const reloadedRun = await reimported.getSandboxRun(runId)
      expect(reloadedRun!.dispositions['watch:E2E-WATCH-1'].state).toBe('approved')
      expect(reloadedRun!.dispositions['ring:E2E-RING-1']).toMatchObject({ state: 'rejected', reason: 'Crop needs adjustment' })
      expect(reloadedRun!.handoffResults['watch:E2E-WATCH-1']).toMatchObject({ ok: true })
      expect(reloadedRun!.handoffResults['ring:E2E-RING-1']).toMatchObject({ ok: true })
      // The real post-processing output directories are still there —
      // reload never re-triggers processing.
      expect(existsSync(reloadedRun!.pipelines.find((p: any) => p.productType === 'watch')!.postProcessingOutputDir!)).toBe(true)
    },
    60000,
  )
})
