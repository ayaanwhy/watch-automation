// Phase 15.3, updated for Phase 15.5's normalization boundary —
// runSandboxWatchEditing exercised directly (not through the full
// orchestrator): proves per-image failure isolation within a single
// product (one bad image must not stop its siblings) and that boundary
// detection is never called more than once per image, using the real
// detectBoundaries/SingleFlightQueue/processWatch path against the real
// sampledata/1688KM11.png (fetch mocked, matching Phase 14/15.0's pattern).
//
// Since Phase 15.5, validation (measureBy/widthMm presence) happens in
// normalizeSandboxProductData.ts BEFORE detection is ever attempted — an
// item that fails validation never triggers a detection call at all
// (previously, Phase 15.3 detected first and checked widthMm after). Test
// assertions below reflect that real, current ordering.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSandboxProductItem } from '../apps/desktop/src/sandbox/lib/normalizeSandboxProductData'
import type { SandboxTemporaryBatchImage } from '../apps/desktop/src/sandbox/types/sandboxTemporaryBatch'

let scratchDir: string
const REAL_WATCH_IMAGE = join(__dirname, '..', 'sampledata', '1688KM11.png')

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
  BrowserWindow: { getAllWindows: () => [] },
}))

function normalizedWatchItems(images: SandboxTemporaryBatchImage[]) {
  return images.map(normalizeSandboxProductItem)
}

describe('runSandboxWatchEditing — per-image isolation (Phase 15.3/15.5)', () => {
  let inputDir: string
  let outputDir: string

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-watch-isolation-test-'))
    inputDir = join(scratchDir, 'in')
    outputDir = join(scratchDir, 'out')
    await mkdir(inputDir, { recursive: true })
    await mkdir(outputDir, { recursive: true })
    await copyFile(REAL_WATCH_IMAGE, join(inputDir, 'GOOD-1.png'))
    await copyFile(REAL_WATCH_IMAGE, join(inputDir, 'BAD-NO-WIDTH.png'))
    await copyFile(REAL_WATCH_IMAGE, join(inputDir, 'GOOD-2.png'))
    await copyFile(REAL_WATCH_IMAGE, join(inputDir, 'GOOD-3.png'))
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('a missing widthMm fails only that image (before detection is even attempted) — its siblings still complete', async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 5))
      return new Response(
        JSON.stringify({ success: true, message: 'ok', case_bbox: [263, 4, 1312, 979], dial_bbox: [356, 57, 1212, 965] }),
        { status: 200 },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { runSandboxWatchEditing } = await import('../apps/desktop/electron/sandbox/sandboxEditingPipeline')

    const result = await runSandboxWatchEditing({
      inputDir,
      outputDir,
      batchId: 'fake-batch-id-not-persisted-check',
      items: normalizedWatchItems([
        { sku: 'GOOD-1', imagePath: '/mock/source.png', productType: 'watch', widthMm: 40, measureBy: 'Case' },
        { sku: 'BAD-NO-WIDTH', imagePath: '/mock/source.png', productType: 'watch', measureBy: 'Case' }, // no widthMm
        { sku: 'GOOD-2', imagePath: '/mock/source.png', productType: 'watch', widthMm: 44, measureBy: 'Case' },
      ]),
    })

    // updateStage will fail (no such batch in this test's registry) and
    // that's fine — it's swallowed as null by batchRegistry.updateStage,
    // which is why batchId is a nonsense placeholder here: this test's
    // job is the per-image outcome, not batch persistence (already proven
    // in sandboxOrchestratorExecution.test.ts).
    const items = result.items!
    const good1 = items.find(i => i.sku === 'GOOD-1')!
    const bad = items.find(i => i.sku === 'BAD-NO-WIDTH')!
    const good2 = items.find(i => i.sku === 'GOOD-2')!

    expect(good1.status).toBe('completed')
    expect(good2.status).toBe('completed')
    expect(bad.status).toBe('failed')
    // Structured, actionable failure (never a bare string): what, which SKU,
    // and a stable code callers can branch on.
    expect(bad.failure?.code).toBe('MISSING_WATCH_WIDTH')
    expect(bad.failure?.retryable).toBe(false)
    expect(bad.error).toContain('BAD-NO-WIDTH')

    // Only the two valid images ever reach detection — the invalid one is
    // caught by validation first (Phase 15.5), so it never calls fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never issues two overlapping detection calls, even across three images', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const fetchMock = vi.fn(async () => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise(r => setTimeout(r, 15))
      inFlight--
      return new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [263, 4, 1312, 979] }), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { runSandboxWatchEditing } = await import('../apps/desktop/electron/sandbox/sandboxEditingPipeline')

    await runSandboxWatchEditing({
      inputDir,
      outputDir,
      batchId: 'fake-batch-id',
      items: normalizedWatchItems([
        { sku: 'GOOD-1', imagePath: '/mock/source.png', productType: 'watch', widthMm: 40, measureBy: 'Case' },
        { sku: 'GOOD-2', imagePath: '/mock/source.png', productType: 'watch', widthMm: 41, measureBy: 'Case' },
        { sku: 'GOOD-3', imagePath: '/mock/source.png', productType: 'watch', widthMm: 42, measureBy: 'Case' },
      ]),
    })

    expect(maxConcurrent).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
