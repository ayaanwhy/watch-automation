// Phase 15.2 — Sandbox Universal Configuration model: selected batch ->
// configuration initialization, validation, and product-type ordering. No
// electron dependency.
import { describe, expect, it } from 'vitest'
import {
  createInitialUniversalConfig,
  defaultPreprocessingConfig,
  validateSandboxUniversalConfig,
  type SandboxUniversalConfig,
} from '../apps/desktop/src/sandbox/types/sandboxUniversalConfig'
import { sortSandboxProductTypes, SANDBOX_PRODUCT_TYPE_ORDER } from '../apps/desktop/src/sandbox/constants/productDisplay'
import { ROTATION_OPTIONS } from '../apps/desktop/src/constants/rotation'
import type { SandboxTemporaryBatchDetail } from '../apps/desktop/src/sandbox/types/sandboxTemporaryBatch'

function makeBatch(overrides: Partial<SandboxTemporaryBatchDetail> = {}): SandboxTemporaryBatchDetail {
  return {
    id: 'batch-1',
    name: 'Test Batch',
    productTypes: ['watch', 'ring'],
    imageCount: 2,
    images: [
      { sku: 'SKU-1', imagePath: '', productType: 'watch' },
      { sku: 'SKU-2', imagePath: '', productType: 'ring' },
    ],
    ...overrides,
  }
}

describe('sortSandboxProductTypes — canonical display order', () => {
  it('orders present product types by the fixed canonical order, not input order', () => {
    expect(sortSandboxProductTypes(['gemstone', 'watch', 'earring'])).toEqual(['watch', 'earring', 'gemstone'])
  })

  it('covers every Sandbox product type exactly once', () => {
    expect(SANDBOX_PRODUCT_TYPE_ORDER).toEqual(['watch', 'ring', 'bracelet', 'earring', 'necklace', 'gemstone'])
  })

  it('drops product types not present, without inventing entries', () => {
    expect(sortSandboxProductTypes(['ring'])).toEqual(['ring'])
    expect(sortSandboxProductTypes([])).toEqual([])
  })
})

describe('ROTATION_OPTIONS (Phase 15.1 shared rotation, reused here)', () => {
  it('exposes exactly the four quarter-turn values, in order, 0deg first', () => {
    expect(ROTATION_OPTIONS.map(o => o.value)).toEqual([0, 90, 180, 270])
    expect(ROTATION_OPTIONS.map(o => o.label)).toEqual(['0°', '90°', '180°', '270°'])
  })
})

describe('default preprocessing config', () => {
  it('defaults to a real upscale factor (no "None"/1x factor exists) and no rotation', () => {
    const config = defaultPreprocessingConfig()
    expect([2, 4]).toContain(config.upscaleFactor)
    expect(config.rotate).toBe(0)
  })
})

describe('createInitialUniversalConfig — selected batch -> configuration initialization', () => {
  it('records the batch id and defaults preprocessing to Legacy-equivalent defaults', () => {
    const config = createInitialUniversalConfig(makeBatch())
    expect(config.temporaryBatchId).toBe('batch-1')
    expect(config.preprocessing).toEqual(defaultPreprocessingConfig())
  })

  it('builds one editingByProduct entry per distinct product type present, never inventing others', () => {
    const config = createInitialUniversalConfig(makeBatch({ productTypes: ['watch', 'ring'] }))
    expect(Object.keys(config.editingByProduct).sort()).toEqual(['ring', 'watch'])
    expect(config.editingByProduct.bracelet).toBeUndefined()
  })

  it('marks an available product type (e.g. Ring) as available with no reason', () => {
    const config = createInitialUniversalConfig(makeBatch({ productTypes: ['ring'] }))
    expect(config.editingByProduct.ring).toEqual({ productType: 'ring', available: true })
  })

  it('marks Necklace unavailable with a reason (not silently dropped) and Gemstone available', () => {
    const config = createInitialUniversalConfig(makeBatch({ productTypes: ['necklace', 'gemstone'] }))
    expect(config.editingByProduct.necklace?.available).toBe(false)
    expect(config.editingByProduct.necklace?.unavailableReason).toBeTruthy()
    expect(config.editingByProduct.gemstone).toEqual({ productType: 'gemstone', available: true })
  })

  it('builds one postProcessingByProduct default selection per product type present', () => {
    const config = createInitialUniversalConfig(makeBatch({ productTypes: ['ring', 'earring'] }))
    expect(config.postProcessingByProduct.ring).toEqual({ autoMCFF: false })
    expect(config.postProcessingByProduct.earring).toEqual({ autoMeasurementCalculator: false })
  })
})

describe('validateSandboxUniversalConfig', () => {
  it('is invalid with no batch/config selected', () => {
    const result = validateSandboxUniversalConfig(null, null)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('is invalid when the batch has no recognizable product types', () => {
    const batch = makeBatch({ productTypes: [] })
    const config = createInitialUniversalConfig(batch)
    const result = validateSandboxUniversalConfig(config, batch)
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.toLowerCase().includes('product type'))).toBe(true)
  })

  it('is invalid when every present product type is unavailable (Necklace only)', () => {
    const batch = makeBatch({ productTypes: ['necklace'] })
    const config = createInitialUniversalConfig(batch)
    const result = validateSandboxUniversalConfig(config, batch)
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.toLowerCase().includes('available'))).toBe(true)
  })

  it('is valid when at least one present product type is available, even alongside an unavailable one', () => {
    const batch = makeBatch({ productTypes: ['ring', 'necklace'] })
    const config = createInitialUniversalConfig(batch)
    const result = validateSandboxUniversalConfig(config, batch)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('is invalid when a configured resize height is not a positive number', () => {
    const batch = makeBatch({ productTypes: ['ring'] })
    const config: SandboxUniversalConfig = {
      ...createInitialUniversalConfig(batch),
      preprocessing: { ...defaultPreprocessingConfig(), resizeToHeight: 0 },
    }
    const result = validateSandboxUniversalConfig(config, batch)
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.toLowerCase().includes('resize'))).toBe(true)
  })

  it('is valid with the plain default configuration for a normal available-product batch', () => {
    const batch = makeBatch()
    const config = createInitialUniversalConfig(batch)
    expect(validateSandboxUniversalConfig(config, batch)).toEqual({ ok: true, errors: [] })
  })
})
