// Phase 15.1 — the shared Legacy/Sandbox "Background Removal + Upscaling"
// vs "Background Removal" presentation rule. No electron dependency.
import { describe, expect, it } from 'vitest'
import {
  formatPreprocessingOperations,
  shouldSuppressUpscaleFromCombinedLabel,
} from '../apps/desktop/src/constants/preprocessingOperations'

describe('shouldSuppressUpscaleFromCombinedLabel', () => {
  it('suppresses when both operations are present and the upscale factor is None (1)', () => {
    expect(shouldSuppressUpscaleFromCombinedLabel(['background_removal', 'upscale'], 1)).toBe(true)
  })

  it('does not suppress when the upscale factor is not None', () => {
    expect(shouldSuppressUpscaleFromCombinedLabel(['background_removal', 'upscale'], 2)).toBe(false)
    expect(shouldSuppressUpscaleFromCombinedLabel(['background_removal', 'upscale'], 4)).toBe(false)
  })

  it('does not suppress when upscale is the only selected operation, even at None', () => {
    expect(shouldSuppressUpscaleFromCombinedLabel(['upscale'], 1)).toBe(false)
  })

  it('does not suppress when background_removal is the only selected operation', () => {
    expect(shouldSuppressUpscaleFromCombinedLabel(['background_removal'], 1)).toBe(false)
  })
})

describe('formatPreprocessingOperations (Batch Details persisted-config summary)', () => {
  it('drops the Upscaling term when both operations ran with a None upscale factor', () => {
    expect(formatPreprocessingOperations(['background_removal', 'upscale'], 1)).toBe('Background Removal')
  })

  it('keeps both terms when both operations ran with a real upscale factor', () => {
    expect(formatPreprocessingOperations(['background_removal', 'upscale'], 2)).toBe('Background Removal + Upscaling')
    expect(formatPreprocessingOperations(['background_removal', 'upscale'], 4)).toBe('Background Removal + Upscaling')
  })

  it('is unaffected for single-operation configs regardless of scale factor', () => {
    expect(formatPreprocessingOperations(['background_removal'], 1)).toBe('Background Removal')
    expect(formatPreprocessingOperations(['upscale'], 1)).toBe('Upscaling')
  })

  it('treats a persisted string "1" the same as the numeric 1 (JSON round-trip safety)', () => {
    expect(formatPreprocessingOperations(['background_removal', 'upscale'], '1')).toBe('Background Removal')
  })

  it('returns null for a missing or empty operations value, matching the other Batch Details formatters', () => {
    expect(formatPreprocessingOperations(undefined, 1)).toBeNull()
    expect(formatPreprocessingOperations([], 1)).toBeNull()
  })
})
