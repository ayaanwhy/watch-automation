import { describe, it, expect } from 'vitest'
import { resolveProvenance } from '../apps/desktop/src/types/annotation'

describe('resolveProvenance', () => {
  it('resolves to manual with null confidence when no prediction exists', () => {
    // The only case any real caller exercises today (Phase 14A) — no
    // detection provider is wired in yet, so every submit passes
    // prediction: null. Must be bit-identical to the old hardcoded stamp.
    expect(resolveProvenance({ leftBoundary: 100, rightBoundary: 400 }, null)).toEqual({
      source: 'manual',
      confidence: null,
    })
  })

  it('resolves to ai when the submitted ints exactly match the prediction', () => {
    expect(
      resolveProvenance(
        { leftBoundary: 100, rightBoundary: 400 },
        { leftBoundary: 100, rightBoundary: 400, confidence: 0.87 }
      )
    ).toEqual({ source: 'ai', confidence: 0.87 })
  })

  it('resolves to ai-adjusted when either boundary differs from the prediction', () => {
    expect(
      resolveProvenance(
        { leftBoundary: 105, rightBoundary: 400 },
        { leftBoundary: 100, rightBoundary: 400, confidence: 0.87 }
      )
    ).toEqual({ source: 'ai-adjusted', confidence: 0.87 })

    expect(
      resolveProvenance(
        { leftBoundary: 100, rightBoundary: 410 },
        { leftBoundary: 100, rightBoundary: 400, confidence: 0.87 }
      )
    ).toEqual({ source: 'ai-adjusted', confidence: 0.87 })
  })

  it('preserves a null prediction confidence through both ai and ai-adjusted', () => {
    expect(
      resolveProvenance(
        { leftBoundary: 100, rightBoundary: 400 },
        { leftBoundary: 100, rightBoundary: 400, confidence: null }
      )
    ).toEqual({ source: 'ai', confidence: null })

    expect(
      resolveProvenance(
        { leftBoundary: 999, rightBoundary: 400 },
        { leftBoundary: 100, rightBoundary: 400, confidence: null }
      )
    ).toEqual({ source: 'ai-adjusted', confidence: null })
  })

  it('uses exact integer equality, not a tolerance — a 1px difference still counts as adjusted', () => {
    expect(
      resolveProvenance(
        { leftBoundary: 101, rightBoundary: 400 },
        { leftBoundary: 100, rightBoundary: 400, confidence: 0.5 }
      )
    ).toEqual({ source: 'ai-adjusted', confidence: 0.5 })
  })
})
