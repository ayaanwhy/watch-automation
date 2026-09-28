// Phase 15.6 — sandboxReviewService.ts: the electron-side review assembly
// (join of a real Legacy Batch's stage images + normalized product data +
// Sandbox-owned disposition) and the approve/reject/handoff logic,
// including persistence and per-item failure handling. batchRegistry and
// sandboxApiClient are mocked so handoff success/failure and stage-image
// state are fully controllable; sandboxRunRegistry runs for real against a
// scratch userData dir (same pattern as sandboxRunRegistry.test.ts) so
// persistence/recovery is genuinely exercised, not assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
}))

const mockGetBatch = vi.fn()
vi.mock('../apps/desktop/electron/services/batchRegistry', () => ({
  getBatch: (id: string) => mockGetBatch(id),
}))

const mockApiClient = {
  listTemporaryBatches: vi.fn(),
  getTemporaryBatchDetail: vi.fn(),
  listEditors: vi.fn(),
  handoffApprovedToQa: vi.fn(async () => ({ ok: true })),
  handoffRejectedToManualEditor: vi.fn(async () => ({ ok: true })),
}
vi.mock('../apps/desktop/electron/sandbox/sandboxApiClient', () => ({
  sandboxApiClient: mockApiClient,
}))

const EDITOR = { id: 'mock-editor-1', name: 'Mock Editor One' }

function stageImage(overrides: Partial<{ name: string; status: 'completed' | 'failed' | 'cancelled'; outputPath: string | null; error: string | null; assets?: any }> = {}) {
  return { name: 'RING-1', status: 'completed', outputPath: '/out/ring-1.png', error: null, durationMs: 100, ...overrides }
}

function makeBatch(stageType: 'editing' | 'watch', images: ReturnType<typeof stageImage>[]) {
  return {
    id: 'batch-1',
    stages: [
      { type: stageType, status: 'completed', inputDir: '', outputDir: null, config: {}, counts: {}, images, ref: {}, createdAt: '', startedAt: null, completedAt: null, error: null },
    ],
  }
}

function makeTemporaryBatch(overrides: Partial<{ images: any[] }> = {}) {
  return {
    id: 'temp-batch-1',
    name: 'Temp Batch',
    productTypes: ['ring'],
    imageCount: 1,
    images: overrides.images ?? [{ sku: 'RING-1', imagePath: '/src/ring-1.png', productType: 'ring' }],
  }
}

describe('sandboxReviewService', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-review-service-test-'))
    vi.resetModules()
    mockGetBatch.mockReset()
    mockApiClient.getTemporaryBatchDetail.mockReset()
    mockApiClient.handoffApprovedToQa.mockReset().mockResolvedValue({ ok: true })
    mockApiClient.handoffRejectedToManualEditor.mockReset().mockResolvedValue({ ok: true })
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  // Phase 15.7 — Final Review now resolves each image's real final artifact
  // against the pipeline's postProcessingOutputDir (see
  // sandboxReviewService.gatherStageSources's resolveFinalArtifactPath),
  // verified via a real fs.stat, not merely trusted from the stage image's
  // own outputPath. So a "ready" fixture run needs a REAL directory
  // containing REAL files with the same basename as whatever the mocked
  // Batch stage's StageImageRecord.outputPath claims — finalFiles lists
  // those basenames to create (empty dummy files; content is never read).
  async function createReadyRun(finalFiles: string[] = ['ring-1.png']) {
    const { createSandboxRun, updateSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const run = await createSandboxRun({ title: 'R', temporaryBatchId: 'temp-batch-1', productTypes: ['ring'], universalConfig: {} })

    const postProcessingOutputDir = join(scratchDir, 'post-processing-output')
    await mkdir(postProcessingOutputDir, { recursive: true })
    for (const filename of finalFiles) {
      await writeFile(join(postProcessingOutputDir, filename), 'final-artifact-bytes')
    }

    // Simulate the orchestrator having completed the ring pipeline,
    // including real post-processing (postProcessingOutputDir set — see
    // sandboxOrchestrator.ts's own final updatePipeline call).
    const updated = await updateSandboxRun(run.id, {
      status: 'completed',
      pipelines: [
        {
          productType: 'ring',
          batchId: 'batch-1',
          status: 'completed',
          error: null,
          stage: 'post_processing',
          postProcessingOutputDir,
          postProcessingArtifacts: [],
        },
      ],
    })
    return updated!
  }

  it('A. getSandboxReviewItems joins Batch stage output + normalized product data + pending disposition', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun()

    const { getSandboxReviewItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const items = await getSandboxReviewItems(run.id)

    expect(items).toHaveLength(1)
    // outputPath is the REAL final post-processing artifact (same basename,
    // inside postProcessingOutputDir — see resolveFinalArtifactPath), not
    // the Editing stage's own '/out/ring-1.png' path.
    expect(items![0]).toMatchObject({
      sku: 'RING-1',
      productType: 'ring',
      processingStatus: 'completed',
      outputPath: join(scratchDir, 'post-processing-output', 'ring-1.png'),
      sourceImagePath: '/src/ring-1.png',
    })
    expect(items![0].disposition.state).toBe('pending')
  })

  it('P. getSandboxReviewItems returns null for an unknown run', async () => {
    const { getSandboxReviewItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    expect(await getSandboxReviewItems('not-a-real-run')).toBeNull()
  })

  it('Q. getSandboxReviewItems returns null when the Sandbox API has no matching Temporary Batch', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(null)
    const run = await createReadyRun()

    const { getSandboxReviewItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    expect(await getSandboxReviewItems(run.id)).toBeNull()
  })

  it('B/8. approveSandboxItems: happy path persists disposition + handoff result and calls handoffApprovedToQa with an opaque artifact ref, not a raw filesystem path check', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage({ assets: { compare: '/out/ring-1-compare.png' } })]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun(['ring-1.png', 'ring-1-compare.png'])

    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const result = await approveSandboxItems(run.id, [{ productType: 'ring', sku: 'RING-1' }])

    expect(result.ok).toBe(true)
    expect(result.results['ring:RING-1']).toEqual({ ok: true })
    // outputArtifactRef/compareArtifactRef now point at the REAL final
    // post-processing artifact (same basename, inside postProcessingOutputDir
    // — see resolveFinalArtifactPath), not the pre-post-processing Editing
    // path the stage image itself carried.
    const { getSandboxRun: getRunForPaths } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const runForPaths = await getRunForPaths(run.id)
    const postProcessingOutputDir = runForPaths!.pipelines[0].postProcessingOutputDir!
    expect(mockApiClient.handoffApprovedToQa).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxRunId: run.id,
        productType: 'ring',
        sku: 'RING-1',
        outputArtifactRef: join(postProcessingOutputDir, 'ring-1.png'),
        compareArtifactRef: join(postProcessingOutputDir, 'ring-1-compare.png'),
      }),
    )

    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const reread = await getSandboxRun(run.id)
    expect(reread!.dispositions['ring:RING-1'].state).toBe('approved')
    expect(reread!.handoffResults['ring:RING-1']).toMatchObject({ ok: true })
  })

  it('C. approveSandboxItems refuses a non-reviewable item (Editing itself failed) without writing a disposition', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage({ status: 'failed', outputPath: null, error: 'boom' })]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun()

    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const result = await approveSandboxItems(run.id, [{ productType: 'ring', sku: 'RING-1' }])

    expect(result.ok).toBe(false)
    expect(result.results['ring:RING-1'].ok).toBe(false)
    expect(mockApiClient.handoffApprovedToQa).not.toHaveBeenCalled()

    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    expect((await getSandboxRun(run.id))!.dispositions['ring:RING-1']).toBeUndefined()
  })

  it('M. duplicate transition prevention: approving an already-approved item is refused and does not re-handoff', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun()

    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const first = await approveSandboxItems(run.id, [{ productType: 'ring', sku: 'RING-1' }])
    expect(first.ok).toBe(true)

    mockApiClient.handoffApprovedToQa.mockClear()
    const second = await approveSandboxItems(run.id, [{ productType: 'ring', sku: 'RING-1' }])
    expect(second.ok).toBe(false)
    expect(second.results['ring:RING-1'].error).toMatch(/already approved/)
    expect(mockApiClient.handoffApprovedToQa).not.toHaveBeenCalled()
  })

  it('F/G. rejectSandboxItems requires a reason and an editor before any handoff is attempted', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun()

    const { rejectSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')

    const noReason = await rejectSandboxItems(run.id, { keys: [{ productType: 'ring', sku: 'RING-1' }], reason: '', editor: EDITOR })
    expect(noReason.ok).toBe(false)
    expect(noReason.results['ring:RING-1'].error).toMatch(/reason/i)

    const noEditor = await rejectSandboxItems(run.id, { keys: [{ productType: 'ring', sku: 'RING-1' }], reason: 'bad crop', editor: null })
    expect(noEditor.ok).toBe(false)
    expect(noEditor.results['ring:RING-1'].error).toMatch(/editor/i)

    expect(mockApiClient.handoffRejectedToManualEditor).not.toHaveBeenCalled()
  })

  it('7/H. rejectSandboxItems happy path: reason + editor persisted, optional instructions trimmed, blank instructions become null', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun()

    const { rejectSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const result = await rejectSandboxItems(run.id, {
      keys: [{ productType: 'ring', sku: 'RING-1' }],
      reason: 'Crop is off-center',
      instructions: '   ',
      editor: EDITOR,
    })

    expect(result.ok).toBe(true)
    const { getSandboxRun: getRunForPaths } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const runForPaths = await getRunForPaths(run.id)
    const postProcessingOutputDir = runForPaths!.pipelines[0].postProcessingOutputDir!
    expect(mockApiClient.handoffRejectedToManualEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxRunId: run.id,
        productType: 'ring',
        sku: 'RING-1',
        // outputArtifactRef is now the real final post-processing artifact
        // (see resolveFinalArtifactPath); sourceArtifactRef is unaffected —
        // it's always the original source image, never post-processed.
        outputArtifactRef: join(postProcessingOutputDir, 'ring-1.png'),
        sourceArtifactRef: '/src/ring-1.png',
        reason: 'Crop is off-center',
        instructions: null,
        assignedEditor: EDITOR,
      }),
    )

    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const reread = await getSandboxRun(run.id)
    expect(reread!.dispositions['ring:RING-1']).toMatchObject({
      state: 'rejected',
      reason: 'Crop is off-center',
      instructions: null,
      assignedEditor: EDITOR,
    })
  })

  it('non-blank instructions are trimmed and preserved', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun()

    const { rejectSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    await rejectSandboxItems(run.id, {
      keys: [{ productType: 'ring', sku: 'RING-1' }],
      reason: 'Crop is off-center',
      instructions: '  please recrop tighter  ',
      editor: EDITOR,
    })

    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const reread = await getSandboxRun(run.id)
    expect(reread!.dispositions['ring:RING-1'].instructions).toBe('please recrop tighter')
  })

  it('J/14. a failed handoff is reported honestly (no false success) and recorded in handoffResults, without inventing an error message', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    mockApiClient.handoffApprovedToQa.mockResolvedValue({ ok: false, error: 'QA service unreachable' })
    const run = await createReadyRun()

    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const result = await approveSandboxItems(run.id, [{ productType: 'ring', sku: 'RING-1' }])

    expect(result.ok).toBe(false)
    expect(result.results['ring:RING-1']).toEqual({ ok: false, error: 'QA service unreachable' })

    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const reread = await getSandboxRun(run.id)
    expect(reread!.handoffResults['ring:RING-1']).toMatchObject({ ok: false, error: 'QA service unreachable' })
  })

  it('I/N. bulk action: one item succeeding and one failing never rolls back the item that succeeded', async () => {
    mockGetBatch.mockResolvedValue(
      makeBatch('editing', [stageImage({ name: 'RING-1' }), stageImage({ name: 'RING-2', status: 'failed', outputPath: null, error: 'bad crop' })]),
    )
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(
      makeTemporaryBatch({
        images: [
          { sku: 'RING-1', imagePath: '/src/ring-1.png', productType: 'ring' },
          { sku: 'RING-2', imagePath: '/src/ring-2.png', productType: 'ring' },
        ],
      }),
    )
    const run = await createReadyRun()

    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const result = await approveSandboxItems(run.id, [
      { productType: 'ring', sku: 'RING-1' },
      { productType: 'ring', sku: 'RING-2' },
    ])

    expect(result.ok).toBe(false) // overall not fully ok
    expect(result.results['ring:RING-1'].ok).toBe(true)
    expect(result.results['ring:RING-2'].ok).toBe(false)

    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const reread = await getSandboxRun(run.id)
    expect(reread!.dispositions['ring:RING-1'].state).toBe('approved')
    expect(reread!.dispositions['ring:RING-2']).toBeUndefined()
  })

  it('L. an item key not present in this run is reported per-item, not thrown', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun()

    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const result = await approveSandboxItems(run.id, [{ productType: 'ring', sku: 'DOES-NOT-EXIST' }])
    expect(result.results['ring:DOES-NOT-EXIST']).toEqual({ ok: false, error: 'Item not found in this run.' })
  })

  it('K. acting on an unknown run id returns ok:false with no results, without throwing', async () => {
    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const result = await approveSandboxItems('not-a-real-run', [{ productType: 'ring', sku: 'RING-1' }])
    expect(result).toEqual({ ok: false, results: {} })
  })

  it('N. two concurrent approve calls against the same run for different items both persist (no lost update)', async () => {
    mockGetBatch.mockResolvedValue(
      makeBatch('editing', [stageImage({ name: 'RING-1' }), stageImage({ name: 'RING-2', outputPath: '/out/ring-2.png' })]),
    )
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(
      makeTemporaryBatch({
        images: [
          { sku: 'RING-1', imagePath: '/src/ring-1.png', productType: 'ring' },
          { sku: 'RING-2', imagePath: '/src/ring-2.png', productType: 'ring' },
        ],
      }),
    )
    const run = await createReadyRun(['ring-1.png', 'ring-2.png'])

    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const [r1, r2] = await Promise.all([
      approveSandboxItems(run.id, [{ productType: 'ring', sku: 'RING-1' }]),
      approveSandboxItems(run.id, [{ productType: 'ring', sku: 'RING-2' }]),
    ])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    const { getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const reread = await getSandboxRun(run.id)
    expect(reread!.dispositions['ring:RING-1'].state).toBe('approved')
    expect(reread!.dispositions['ring:RING-2'].state).toBe('approved')
  })

  it('recovery: disposition set before a simulated reload (module reset) is still readable afterward', async () => {
    mockGetBatch.mockResolvedValue(makeBatch('editing', [stageImage()]))
    mockApiClient.getTemporaryBatchDetail.mockResolvedValue(makeTemporaryBatch())
    const run = await createReadyRun()

    const { approveSandboxItems } = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    await approveSandboxItems(run.id, [{ productType: 'ring', sku: 'RING-1' }])

    vi.resetModules()
    const reimported = await import('../apps/desktop/electron/sandbox/sandboxReviewService')
    const items = await reimported.getSandboxReviewItems(run.id)
    expect(items!.find(i => i.sku === 'RING-1')!.disposition.state).toBe('approved')
  })
})
