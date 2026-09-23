// Phase 15.2 — Sandbox post-processing script catalog: canonical order,
// compulsory-vs-optional state, and the selection helpers the config UI
// uses. No electron dependency (pure data + pure functions).
import { describe, expect, it } from 'vitest'
import {
  SANDBOX_POST_PROCESSING_SCRIPTS,
  defaultPostProcessingSelection,
  resolveSelectedScripts,
} from '../apps/desktop/src/sandbox/types/sandboxPostProcessing'
import { SANDBOX_PRODUCT_AVAILABILITY, type SandboxProductType } from '../apps/desktop/src/sandbox/types/sandboxProduct'

const ALL_PRODUCT_TYPES: SandboxProductType[] = ['watch', 'ring', 'bracelet', 'earring', 'necklace', 'gemstone']

describe('SANDBOX_POST_PROCESSING_SCRIPTS — canonical order (as supplied)', () => {
  it('has an entry for every Sandbox product type', () => {
    for (const productType of ALL_PRODUCT_TYPES) {
      expect(SANDBOX_POST_PROCESSING_SCRIPTS[productType]).toBeDefined()
      expect(SANDBOX_POST_PROCESSING_SCRIPTS[productType].length).toBeGreaterThan(0)
    }
  })

  it('Ring matches the given canonical order exactly', () => {
    expect(SANDBOX_POST_PROCESSING_SCRIPTS.ring.map(s => s.id)).toEqual([
      'imageResizeNew',
      'compressorNew',
      'makeCompareRB',
      'autoMCFF',
    ])
  })

  it('Bracelet matches the given canonical order exactly', () => {
    expect(SANDBOX_POST_PROCESSING_SCRIPTS.bracelet.map(s => s.id)).toEqual([
      'imageResizeNew',
      'compressorNew',
      'makeCompareRB',
      'autoMCFF',
    ])
  })

  it('Earring matches the given canonical order exactly', () => {
    expect(SANDBOX_POST_PROCESSING_SCRIPTS.earring.map(s => s.id)).toEqual(['compressorNew', 'autoMeasurementCalculator'])
  })

  it('Necklace matches the given canonical order exactly', () => {
    expect(SANDBOX_POST_PROCESSING_SCRIPTS.necklace.map(s => s.id)).toEqual(['compressorNew'])
  })

  it('Watch matches the given canonical order exactly', () => {
    expect(SANDBOX_POST_PROCESSING_SCRIPTS.watch.map(s => s.id)).toEqual(['removeShadows', 'compressorNew'])
  })

  it('Gemstone matches the given canonical order exactly', () => {
    expect(SANDBOX_POST_PROCESSING_SCRIPTS.gemstone.map(s => s.id)).toEqual(['resizeGems', 'compressorNew'])
  })

  it('autoMCFF and autoMeasurementCalculator are the only optional scripts; everything else is compulsory', () => {
    const optionalIds = new Set(['autoMCFF', 'autoMeasurementCalculator'])
    for (const productType of ALL_PRODUCT_TYPES) {
      for (const script of SANDBOX_POST_PROCESSING_SCRIPTS[productType]) {
        expect(script.compulsory).toBe(!optionalIds.has(script.id))
      }
    }
  })
})

describe('defaultPostProcessingSelection', () => {
  it('defaults every optional script to disabled and omits compulsory scripts entirely', () => {
    expect(defaultPostProcessingSelection('ring')).toEqual({ autoMCFF: false })
    expect(defaultPostProcessingSelection('earring')).toEqual({ autoMeasurementCalculator: false })
  })

  it('is an empty selection for a product with no optional scripts', () => {
    expect(defaultPostProcessingSelection('necklace')).toEqual({})
    expect(defaultPostProcessingSelection('watch')).toEqual({})
    expect(defaultPostProcessingSelection('gemstone')).toEqual({})
  })
})

describe('resolveSelectedScripts', () => {
  it('always includes every compulsory script regardless of selection contents', () => {
    const resolved = resolveSelectedScripts('ring', {})
    expect(resolved.map(s => s.id)).toEqual(['imageResizeNew', 'compressorNew', 'makeCompareRB'])
  })

  it('includes an optional script only when explicitly toggled true, in canonical order', () => {
    const resolved = resolveSelectedScripts('ring', { autoMCFF: true })
    expect(resolved.map(s => s.id)).toEqual(['imageResizeNew', 'compressorNew', 'makeCompareRB', 'autoMCFF'])
  })

  it('an optional script explicitly set to false is excluded, same as omitted', () => {
    const resolved = resolveSelectedScripts('earring', { autoMeasurementCalculator: false })
    expect(resolved.map(s => s.id)).toEqual(['compressorNew'])
  })
})

describe('SANDBOX_PRODUCT_AVAILABILITY — unavailable Necklace/Gemstone capability state', () => {
  it('Necklace and Gemstone are explicitly unavailable with a reason', () => {
    expect(SANDBOX_PRODUCT_AVAILABILITY.necklace.available).toBe(false)
    expect(SANDBOX_PRODUCT_AVAILABILITY.necklace.reason).toBeTruthy()
    expect(SANDBOX_PRODUCT_AVAILABILITY.gemstone.available).toBe(false)
    expect(SANDBOX_PRODUCT_AVAILABILITY.gemstone.reason).toBeTruthy()
  })

  it('Watch, Ring, Bracelet, and Earring are all available', () => {
    expect(SANDBOX_PRODUCT_AVAILABILITY.watch.available).toBe(true)
    expect(SANDBOX_PRODUCT_AVAILABILITY.ring.available).toBe(true)
    expect(SANDBOX_PRODUCT_AVAILABILITY.bracelet.available).toBe(true)
    expect(SANDBOX_PRODUCT_AVAILABILITY.earring.available).toBe(true)
  })
})
