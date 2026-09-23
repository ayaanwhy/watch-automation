// Phase 15.2 — MockSandboxApiClient's extended fixture data actually
// covers what the Dashboard/Universal Configuration UI needs to exercise:
// every currently-real pipeline in one batch, and an unavailable-only
// batch (Necklace/Gemstone) so that state has real mock data behind it. No
// electron dependency (sandboxApiClient.ts is pure).
import { describe, expect, it } from 'vitest'
import { MockSandboxApiClient } from '../apps/desktop/electron/sandbox/sandboxApiClient'

describe('MockSandboxApiClient', () => {
  it('lists every mock Temporary Batch as a summary (no images field)', async () => {
    const client = new MockSandboxApiClient()
    const batches = await client.listTemporaryBatches()
    expect(batches.length).toBeGreaterThanOrEqual(3)
    for (const batch of batches) {
      expect('images' in batch).toBe(false)
    }
  })

  it('includes at least one batch covering every currently-available product type', async () => {
    const client = new MockSandboxApiClient()
    const batches = await client.listTemporaryBatches()
    const allProductTypes = new Set(batches.flatMap(b => b.productTypes))
    for (const productType of ['watch', 'ring', 'bracelet', 'earring'] as const) {
      expect(allProductTypes.has(productType)).toBe(true)
    }
  })

  it('includes a batch containing only the unavailable product types (Necklace/Gemstone)', async () => {
    const client = new MockSandboxApiClient()
    const batches = await client.listTemporaryBatches()
    const unavailableOnly = batches.find(b => b.productTypes.every(p => p === 'necklace' || p === 'gemstone'))
    expect(unavailableOnly).toBeDefined()
    expect(unavailableOnly?.productTypes.length).toBeGreaterThan(0)
  })

  it('getTemporaryBatchDetail returns the full detail (with images) for a real id, null for an unknown one', async () => {
    const client = new MockSandboxApiClient()
    const summaries = await client.listTemporaryBatches()
    const detail = await client.getTemporaryBatchDetail(summaries[0].id)
    expect(detail).not.toBeNull()
    expect(Array.isArray(detail?.images)).toBe(true)
    expect(detail?.images.length).toBe(detail?.imageCount)

    expect(await client.getTemporaryBatchDetail('not-a-real-id')).toBeNull()
  })
})
