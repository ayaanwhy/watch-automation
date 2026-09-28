// Phase 15.5 — the one authoritative Sandbox product-data normalization
// boundary. Pure, no electron/React/filesystem dependency — no mocks
// needed anywhere in this file, which is itself part of what's being
// proven (section 17's "independent of filesystem operations").
import { describe, expect, it } from 'vitest'
import {
  normalizeSandboxProductItem,
  normalizeSandboxTemporaryBatch,
  validateSandboxProductData,
  summarizeSandboxProductValidation,
  hasAnyRunnableItem,
  isSandboxProductTypeAvailable,
} from '../apps/desktop/src/sandbox/lib/normalizeSandboxProductData'
import type { SandboxTemporaryBatchImage, SandboxTemporaryBatchDetail } from '../apps/desktop/src/sandbox/types/sandboxTemporaryBatch'
import type { SandboxWatchMeasurement, SandboxEarringMeasurement, SandboxGenericMeasurement } from '../apps/desktop/src/sandbox/types/sandboxProductData'

function watchImage(overrides: Partial<SandboxTemporaryBatchImage> = {}): SandboxTemporaryBatchImage {
  return { sku: 'WATCH-1', imagePath: '/source/watch-1.png', productType: 'watch', ...overrides }
}

describe('normalizeSandboxProductItem — A. raw -> normalized', () => {
  it('carries sku/productType/imagePath through unchanged for a well-formed item', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: 42, measureBy: 'Case' }))
    expect(item.sku).toBe('WATCH-1')
    expect(item.productType).toBe('watch')
    expect(item.imagePath).toBe('/source/watch-1.png')
  })

  it('normalizes an empty-string imagePath to null, never an empty string downstream', () => {
    const item = normalizeSandboxProductItem(watchImage({ imagePath: '' }))
    expect(item.imagePath).toBeNull()
  })
})

describe('B/C/D. measurement — valid, missing, invalid', () => {
  it('B: a positive finite widthMm is valid, with metadata provenance retaining the raw value', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: 42, measureBy: 'Case' }))
    const m = item.measurement as SandboxWatchMeasurement
    expect(m.widthMm).toBe(42)
    expect(m.provenance).toEqual({ kind: 'metadata', raw: 42 })
  })

  it('C: an absent widthMm normalizes to null with null provenance (genuinely never attempted), not 0', () => {
    const item = normalizeSandboxProductItem(watchImage({ measureBy: 'Case' }))
    const m = item.measurement as SandboxWatchMeasurement
    expect(m.widthMm).toBeNull()
    expect(m.provenance).toBeNull()
    expect(m.widthMm).not.toBe(0)
  })

  it('D: a negative widthMm is invalid — null value, but provenance retains the raw invalid number (distinct from missing)', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: -5, measureBy: 'Case' }))
    const m = item.measurement as SandboxWatchMeasurement
    expect(m.widthMm).toBeNull()
    expect(m.provenance).toEqual({ kind: 'metadata', raw: -5 })
  })

  it('D: NaN/Infinity/0 are all treated as invalid, never coerced into a usable value', () => {
    for (const bad of [NaN, Infinity, 0]) {
      const item = normalizeSandboxProductItem(watchImage({ widthMm: bad, measureBy: 'Case' }))
      const m = item.measurement as SandboxWatchMeasurement
      expect(m.widthMm).toBeNull()
    }
  })
})

describe('E. unit normalization', () => {
  it('every measurement carries the canonical mm unit — the only unit any real data in this repo uses', () => {
    const watch = normalizeSandboxProductItem(watchImage({ widthMm: 42, measureBy: 'Case' })).measurement as SandboxWatchMeasurement
    expect(watch.unit).toBe('mm')
    const ring = normalizeSandboxProductItem({ sku: 'R', imagePath: '/r.png', productType: 'ring', widthMm: 18 })
      .measurement as SandboxGenericMeasurement
    expect(ring.unit).toBe('mm')
  })
})

describe('F/O. provenance preservation and raw retention', () => {
  it('retains the exact raw value that produced a normalized measurement', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: 44.25, measureBy: 'Dial' }))
    const m = item.measurement as SandboxWatchMeasurement
    expect(m.provenance).toEqual({ kind: 'metadata', raw: 44.25 })
  })

  it('does not round or otherwise lose precision from the source value', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: 30.123456, measureBy: 'Case' }))
    const m = item.measurement as SandboxWatchMeasurement
    expect(m.widthMm).toBe(30.123456)
  })
})

describe('G/K. product-type normalization and unsupported types', () => {
  it('G: passes through a known product type’s availability from the single existing SANDBOX_PRODUCT_AVAILABILITY source', () => {
    const item = normalizeSandboxProductItem({ sku: 'R', imagePath: '/r.png', productType: 'ring' })
    expect(item.availability).toEqual({ available: true })
  })

  it('K: an unrecognized product type (bypassing the type system, as a real API could) is explicitly unavailable, never crashes or silently maps to a known type', () => {
    const item = normalizeSandboxProductItem({
      sku: 'X',
      imagePath: '/x.png',
      productType: 'chain-bracelet-necklace-hybrid' as unknown as SandboxTemporaryBatchImage['productType'],
    })
    expect(item.availability.available).toBe(false)
    expect(item.availability.reason).toBeTruthy()
    expect(isSandboxProductTypeAvailable('chain-bracelet-necklace-hybrid' as unknown as never)).toBe(false)
  })
})

describe('H/I. Watch Case vs Dial semantics', () => {
  it('H: Measure By Case is preserved verbatim, not reinterpreted or renamed', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: 42, measureBy: 'Case' }))
    const m = item.measurement as SandboxWatchMeasurement
    expect(m.measureBy).toBe('Case')
    expect(m.widthMm).toBe(42)
  })

  it('I: Measure By Dial is preserved verbatim and distinctly from Case', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: 28.4, measureBy: 'Dial' }))
    const m = item.measurement as SandboxWatchMeasurement
    expect(m.measureBy).toBe('Dial')
    expect(m.widthMm).toBe(28.4)
  })

  it('never defaults an absent measureBy to Case or Dial (Phase 15.3 correction) — stays explicitly null', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: 42 }))
    const m = item.measurement as SandboxWatchMeasurement
    expect(m.measureBy).toBeNull()
  })
})

describe('J. Earring metadata', () => {
  it('carries a real earringType through as classification, not a numeric measurement', () => {
    const item = normalizeSandboxProductItem({ sku: 'E', imagePath: '/e.png', productType: 'earring', earringType: 'hoop' })
    const m = item.measurement as SandboxEarringMeasurement
    expect(m.kind).toBe('earring')
    expect(m.earringType).toBe('hoop')
  })

  it('an absent earringType normalizes to null, not a guessed type', () => {
    const item = normalizeSandboxProductItem({ sku: 'E', imagePath: '/e.png', productType: 'earring' })
    const m = item.measurement as SandboxEarringMeasurement
    expect(m.earringType).toBeNull()
  })
})

describe('L. unavailable product capability', () => {
  it('Necklace is unavailable at the item level, distinctly from an invalid item', () => {
    const necklace = normalizeSandboxProductItem({ sku: 'N', imagePath: '/n.png', productType: 'necklace' })
    const result = validateSandboxProductData(necklace)
    expect(result.level).toBe('unavailable')
    expect(result.issues[0].message).toBeTruthy()
  })
})

describe('N. validation results — all four levels', () => {
  it('VALID: a fully-specified Watch item', () => {
    const item = normalizeSandboxProductItem(watchImage({ widthMm: 42, measureBy: 'Case' }))
    expect(validateSandboxProductData(item).level).toBe('valid')
  })

  it('VALID_WITH_WARNINGS: a Ring/Bracelet item with no measurement data (not required by any real pipeline today)', () => {
    const item = normalizeSandboxProductItem({ sku: 'R', imagePath: '/r.png', productType: 'ring' })
    const result = validateSandboxProductData(item)
    expect(result.level).toBe('valid_with_warnings')
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('INVALID: a Watch item missing both measureBy and widthMm', () => {
    const item = normalizeSandboxProductItem(watchImage())
    const result = validateSandboxProductData(item)
    expect(result.level).toBe('invalid')
    expect(result.issues.map(i => i.field)).toEqual(expect.arrayContaining(['measureBy', 'widthMm']))
  })

  it('INVALID: an Earring item missing earringType', () => {
    const item = normalizeSandboxProductItem({ sku: 'E', imagePath: '/e.png', productType: 'earring' })
    const result = validateSandboxProductData(item)
    expect(result.level).toBe('invalid')
    expect(result.issues[0].field).toBe('earringType')
  })

  it('UNAVAILABLE: Necklace, regardless of how complete its other data is', () => {
    const item = normalizeSandboxProductItem({ sku: 'N', imagePath: '/n.png', productType: 'necklace', widthMm: 5, heightMm: 5 })
    expect(validateSandboxProductData(item).level).toBe('unavailable')
  })

  describe('Gemstone — Shape, width and height are all required and never defaulted', () => {
    const gem = (extra: object = {}) => normalizeSandboxProductItem({ sku: 'G', imagePath: '/g.png', productType: 'gemstone', ...extra } as any)

    it('VALID when width, height and Shape are all present (Shape preserved exactly as given)', () => {
      const item = gem({ widthMm: 6, heightMm: 4, shape: '  Pear Brilliant ' })
      expect(item.measurement).toMatchObject({ kind: 'gemstone', widthMm: 6, heightMm: 4, shape: 'Pear Brilliant' })
      expect(validateSandboxProductData(item).level).toBe('valid')
    })

    it('missing Shape is INVALID with MISSING_GEMSTONE_SHAPE — never silently defaulted', () => {
      const item = gem({ widthMm: 6, heightMm: 4 })
      expect(item.measurement).toMatchObject({ kind: 'gemstone', shape: null })
      const result = validateSandboxProductData(item)
      expect(result.level).toBe('invalid')
      expect(result.issues.map(i => i.code)).toEqual(['MISSING_GEMSTONE_SHAPE'])
    })

    it('a blank/whitespace Shape counts as missing', () => {
      expect(validateSandboxProductData(gem({ widthMm: 6, heightMm: 4, shape: '   ' })).issues[0].code).toBe('MISSING_GEMSTONE_SHAPE')
    })

    it('missing or non-positive dimensions are INVALID with INVALID_GEMSTONE_DIMENSIONS, and invalid stays distinguishable from missing', () => {
      const missing = validateSandboxProductData(gem({ shape: 'round' }))
      expect(missing.issues.map(i => i.code)).toEqual(['INVALID_GEMSTONE_DIMENSIONS'])
      const invalid = gem({ shape: 'round', widthMm: -3, heightMm: 4 })
      expect(invalid.measurement).toMatchObject({ widthMm: null, provenance: { kind: 'metadata', raw: -3 } })
      expect(validateSandboxProductData(invalid).issues[0].message).toMatch(/not valid positive/)
    })

    it('reports every problem at once (shape AND dimensions)', () => {
      expect(validateSandboxProductData(gem()).issues.map(i => i.code)).toEqual(['MISSING_GEMSTONE_SHAPE', 'INVALID_GEMSTONE_DIMENSIONS'])
    })
  })

  it('a product whose pipeline exists is never classified invalid merely for lacking a future pipeline feature', () => {
    // Ring/Bracelet's real pipeline doesn't consume measurement at all —
    // missing it must never be 'invalid', only a warning at most.
    const item = normalizeSandboxProductItem({ sku: 'BR', imagePath: '/br.png', productType: 'bracelet' })
    expect(validateSandboxProductData(item).level).not.toBe('invalid')
  })
})

describe('M. batch normalization', () => {
  it('normalizes every image in a Temporary Batch, preserving batch id/name', () => {
    const batch: SandboxTemporaryBatchDetail = {
      id: 'batch-1',
      name: 'Test Batch',
      productTypes: ['watch', 'ring'],
      imageCount: 2,
      images: [watchImage({ widthMm: 42, measureBy: 'Case' }), { sku: 'R', imagePath: '/r.png', productType: 'ring' }],
    }
    const normalized = normalizeSandboxTemporaryBatch(batch)
    expect(normalized.id).toBe('batch-1')
    expect(normalized.name).toBe('Test Batch')
    expect(normalized.items).toHaveLength(2)
    expect(normalized.items[0].sku).toBe('WATCH-1')
    expect(normalized.items[1].sku).toBe('R')
  })
})

describe('summarizeSandboxProductValidation / hasAnyRunnableItem', () => {
  it('groups by product type and counts each validation level correctly', () => {
    const items = [
      normalizeSandboxProductItem(watchImage({ sku: 'W1', widthMm: 42, measureBy: 'Case' })),
      normalizeSandboxProductItem(watchImage({ sku: 'W2' })), // invalid
      normalizeSandboxProductItem({ sku: 'R1', imagePath: '/r.png', productType: 'ring' }), // warning
    ]
    const summaries = summarizeSandboxProductValidation(items)
    const watchSummary = summaries.find(s => s.productType === 'watch')!
    expect(watchSummary.total).toBe(2)
    expect(watchSummary.valid).toBe(1)
    expect(watchSummary.invalid).toBe(1)
    const ringSummary = summaries.find(s => s.productType === 'ring')!
    expect(ringSummary.validWithWarnings).toBe(1)
  })

  it('hasAnyRunnableItem is true if at least one item is valid or valid_with_warnings', () => {
    const onlyInvalid = [normalizeSandboxProductItem(watchImage())]
    expect(hasAnyRunnableItem({ id: 'b', name: 'B', items: onlyInvalid })).toBe(false)

    const oneValid = [...onlyInvalid, normalizeSandboxProductItem(watchImage({ sku: 'W2', widthMm: 40, measureBy: 'Case' }))]
    expect(hasAnyRunnableItem({ id: 'b', name: 'B', items: oneValid })).toBe(true)
  })
})

describe('P. Legacy isolation', () => {
  it('Legacy batch/stage types have no measurement/provenance concept added to them', async () => {
    const batchTypes = await import('../apps/desktop/src/types/batch')
    // Structural check: a real Legacy StageImageRecord-shaped object must
    // not require any Sandbox measurement field to type-check/exist at
    // runtime — this module simply has no such export to begin with.
    expect((batchTypes as Record<string, unknown>).SandboxMeasurement).toBeUndefined()
    expect((batchTypes as Record<string, unknown>).SandboxProductMeasurementInfo).toBeUndefined()
  })

  it('normalization never mutates the raw input object it was given', () => {
    const raw = watchImage({ widthMm: 42, measureBy: 'Case' })
    const rawCopy = { ...raw }
    normalizeSandboxProductItem(raw)
    expect(raw).toEqual(rawCopy)
  })
})
