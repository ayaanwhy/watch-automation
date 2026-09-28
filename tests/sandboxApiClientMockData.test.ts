// Phase 15.2, extended 15.3 — MockSandboxApiClient's fixture data covers
// what the Dashboard/Universal Configuration UI needs (every real
// pipeline in one batch, an unavailable-only batch) AND, since Phase
// 15.3, what real execution needs: a real image path + widthMm/measureBy
// for Watch (sampleWatchImagePath() now resolves via app.getAppPath(),
// mirroring preprocessHandlers.ts's own convention — hence the electron
// mock below, unlike 15.2's version of this file).
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const FAKE_APP_PATH = join(__dirname, '..', 'apps', 'desktop')

vi.mock('electron', () => ({
  app: { getAppPath: () => FAKE_APP_PATH },
}))

describe('MockSandboxApiClient', () => {
  it('lists every mock Temporary Batch as a summary (no images field)', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()
    const batches = await client.listTemporaryBatches()
    expect(batches.length).toBeGreaterThanOrEqual(3)
    for (const batch of batches) {
      expect('images' in batch).toBe(false)
    }
  })

  it('includes at least one batch covering every currently-available product type', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()
    const batches = await client.listTemporaryBatches()
    const allProductTypes = new Set(batches.flatMap(b => b.productTypes))
    for (const productType of ['watch', 'ring', 'bracelet', 'earring'] as const) {
      expect(allProductTypes.has(productType)).toBe(true)
    }
  })

  it('includes a batch containing only the unavailable product types (Necklace/Gemstone)', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()
    const batches = await client.listTemporaryBatches()
    const unavailableOnly = batches.find(b => b.productTypes.every(p => p === 'necklace' || p === 'gemstone'))
    expect(unavailableOnly).toBeDefined()
    expect(unavailableOnly?.productTypes.length).toBeGreaterThan(0)
  })

  it('getTemporaryBatchDetail returns the full detail (with images) for a real id, null for an unknown one', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()
    const summaries = await client.listTemporaryBatches()
    const detail = await client.getTemporaryBatchDetail(summaries[0].id)
    expect(detail).not.toBeNull()
    expect(Array.isArray(detail?.images)).toBe(true)
    expect(detail?.images.length).toBe(detail?.imageCount)

    expect(await client.getTemporaryBatchDetail('not-a-real-id')).toBeNull()
  })

  it('Watch mock images point at a real, existing file, with a mix of Case/Dial/missing/invalid measurement (Phase 15.5)', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()
    const summaries = await client.listTemporaryBatches()
    const withWatch = summaries.find(b => b.productTypes.includes('watch'))
    expect(withWatch).toBeDefined()
    const detail = await client.getTemporaryBatchDetail(withWatch!.id)
    const watchImages = detail!.images.filter(i => i.productType === 'watch')
    expect(watchImages.length).toBeGreaterThan(0)
    // Every Watch image has a real, existing source file, regardless of
    // whether its measurement data is complete.
    for (const image of watchImages) {
      expect(image.imagePath).not.toBe('')
      expect(existsSync(image.imagePath)).toBe(true)
    }
    // But measurement completeness deliberately varies (Phase 15.5) — at
    // least one valid Case, one valid Dial, one missing, one invalid.
    expect(watchImages.some(i => i.measureBy === 'Case' && typeof i.widthMm === 'number' && i.widthMm > 0)).toBe(true)
    expect(watchImages.some(i => i.measureBy === 'Dial' && typeof i.widthMm === 'number' && i.widthMm > 0)).toBe(true)
    expect(watchImages.some(i => i.widthMm === undefined && i.measureBy === undefined)).toBe(true)
    expect(watchImages.some(i => typeof i.widthMm === 'number' && i.widthMm < 0)).toBe(true)
  })

  it('Earring mock images include both a classified and an unclassified item (Phase 15.5)', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()
    const summaries = await client.listTemporaryBatches()
    const withEarring = summaries.find(b => b.productTypes.includes('earring'))
    expect(withEarring).toBeDefined()
    const detail = await client.getTemporaryBatchDetail(withEarring!.id)
    const earringImages = detail!.images.filter(i => i.productType === 'earring')
    expect(earringImages.length).toBeGreaterThan(0)
    expect(earringImages.some(i => i.earringType !== undefined)).toBe(true)
    expect(earringImages.some(i => i.earringType === undefined)).toBe(true)
    for (const image of earringImages.filter(i => i.earringType !== undefined)) {
      expect(['stud', 'drop', 'hoop']).toContain(image.earringType)
    }
  })

  it('Ring/Bracelet mock images carry generic width/height product data (Phase 15.5)', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()
    const summaries = await client.listTemporaryBatches()
    const batch = summaries.find(b => b.productTypes.includes('bracelet'))
    expect(batch).toBeDefined()
    const detail = await client.getTemporaryBatchDetail(batch!.id)
    const bracelet = detail!.images.find(i => i.productType === 'bracelet')
    expect(bracelet?.widthMm).toBeGreaterThan(0)
    expect(bracelet?.heightMm).toBeGreaterThan(0)
  })

  it('listEditors returns the fixed, clearly-mock editor list Final Review\'s rejection flow assigns from (Phase 15.6)', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()
    const editors = await client.listEditors()
    expect(editors.length).toBeGreaterThan(0)
    for (const editor of editors) {
      expect(editor.id).toBeTruthy()
      expect(editor.name).toBeTruthy()
    }
  })

  it('handoffApprovedToQa/handoffRejectedToManualEditor both report ok:true and are recorded in the mock-only handoff log (Phase 15.6)', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const client = new MockSandboxApiClient()

    const qaResult = await client.handoffApprovedToQa({
      sandboxRunId: 'run-1',
      productType: 'ring',
      sku: 'RING-1',
      outputArtifactRef: '/out/ring-1.png',
      compareArtifactRef: null,
    })
    expect(qaResult).toEqual({ ok: true })

    const manualResult = await client.handoffRejectedToManualEditor({
      sandboxRunId: 'run-1',
      productType: 'ring',
      sku: 'RING-2',
      outputArtifactRef: '/out/ring-2.png',
      sourceArtifactRef: '/src/ring-2.png',
      reason: 'bad crop',
      instructions: null,
      assignedEditor: { id: 'mock-editor-1', name: 'Mock Editor One' },
    })
    expect(manualResult).toEqual({ ok: true })

    const log = client.getHandoffLog()
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ kind: 'qa', payload: { sku: 'RING-1' } })
    expect(log[1]).toMatchObject({ kind: 'manual-editor', payload: { sku: 'RING-2', reason: 'bad crop' } })
    for (const entry of log) {
      expect(typeof entry.at).toBe('string')
      expect(Number.isNaN(Date.parse(entry.at))).toBe(false)
    }
  })

  it('each MockSandboxApiClient instance keeps its own independent handoff log', async () => {
    const { MockSandboxApiClient } = await import('../apps/desktop/electron/sandbox/sandboxApiClient')
    const clientA = new MockSandboxApiClient()
    const clientB = new MockSandboxApiClient()

    await clientA.handoffApprovedToQa({ sandboxRunId: 'run-a', productType: 'ring', sku: 'RING-1', outputArtifactRef: '/out/a.png', compareArtifactRef: null })
    expect(clientA.getHandoffLog()).toHaveLength(1)
    expect(clientB.getHandoffLog()).toHaveLength(0)
  })
})
