import { describe, it, expect } from 'vitest'
import { clampBoundary } from '../apps/desktop/src/context/AnnotationContext'

// Phase 14C — clampBoundary combines the pre-existing rounding/clamping
// logic (unchanged from 14A/earlier) with resolveProvenance (14A, already
// covered by boundaryProvenance.test.ts) against a live AI prediction. This
// file covers the combination, not resolveProvenance's own cases again.
describe('clampBoundary — Phase 14C submission provenance', () => {
  it('resolves to manual/null when no prediction was shown (bit-identical to pre-14C behavior)', () => {
    const result = clampBoundary({ leftBoundary: 100, rightBoundary: 500 }, null)
    expect(result).toEqual({ leftBoundary: 100, rightBoundary: 500, source: 'manual', confidence: null })
  })

  it('resolves to ai when the submitted values exactly match the prediction', () => {
    const result = clampBoundary(
      { leftBoundary: 263, rightBoundary: 1312 },
      { leftBoundary: 263, rightBoundary: 1312, confidence: null },
    )
    expect(result).toEqual({ leftBoundary: 263, rightBoundary: 1312, source: 'ai', confidence: null })
  })

  it('resolves to ai-adjusted when the operator moved a guide away from the prediction', () => {
    const result = clampBoundary(
      { leftBoundary: 270, rightBoundary: 1312 },
      { leftBoundary: 263, rightBoundary: 1312, confidence: null },
    )
    expect(result).toEqual({ leftBoundary: 270, rightBoundary: 1312, source: 'ai-adjusted', confidence: null })
  })

  it('still clamps/rounds before comparing against the prediction — a submission that rounds to the same ints as the prediction still counts as untouched', () => {
    const result = clampBoundary(
      { leftBoundary: 263.4, rightBoundary: 1311.6 },
      { leftBoundary: 263, rightBoundary: 1312, confidence: null },
    )
    expect(result.source).toBe('ai')
  })

  it('enforces MIN_GUIDE_SEPARATION regardless of prediction presence', () => {
    const result = clampBoundary({ leftBoundary: 500, rightBoundary: 502 }, null)
    expect(result.rightBoundary - result.leftBoundary).toBeGreaterThanOrEqual(10)
  })
})
