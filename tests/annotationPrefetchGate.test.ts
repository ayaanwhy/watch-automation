import { describe, it, expect } from 'vitest'
import { isPrefetchEligible } from '../apps/desktop/src/context/AnnotationContext'

// Phase 14C sequencing regression (2026-09-18) — isPrefetchEligible is the
// exact guard that gates AnnotationContext's prefetch effect. Before this
// fix, the prefetch effect fired unconditionally alongside the current-SKU
// trigger effect on mount, so opening a fresh Automatic batch dispatched
// two concurrent /bbox/predict requests. Reproduced directly against the
// live watchdialcoord.clouddeploy.in API: two concurrent requests reliably
// hang the entire service. This test locks in the one property that
// prevents that: prefetch must never be eligible while the current SKU's
// own detection is still outstanding ('idle' or 'pending').
describe('isPrefetchEligible — prefetch/current-detection serialization guard', () => {
  const base = {
    aiDetectionEnabled: true,
    currentStatus: 'unannotated' as const,
    currentSpliceBoundaries: null,
    currentDetectionStatus: 'idle' as const,
  }

  it('blocks prefetch while the current SKU has not started detecting yet (idle) — the exact case that caused the concurrent pair on mount', () => {
    expect(isPrefetchEligible({ ...base, currentDetectionStatus: 'idle' })).toBe(false)
  })

  it('blocks prefetch while the current SKU detection is genuinely in flight (pending)', () => {
    expect(isPrefetchEligible({ ...base, currentDetectionStatus: 'pending' })).toBe(false)
  })

  it('allows prefetch once the current SKU detection has settled successfully', () => {
    expect(isPrefetchEligible({ ...base, currentDetectionStatus: 'success' })).toBe(true)
  })

  it('allows prefetch once the current SKU detection has settled as a failure', () => {
    expect(isPrefetchEligible({ ...base, currentDetectionStatus: 'failed' })).toBe(true)
  })

  it('allows prefetch immediately when detection is disabled (manual mode) — nothing to serialize against', () => {
    expect(isPrefetchEligible({ ...base, aiDetectionEnabled: false, currentDetectionStatus: 'idle' })).toBe(true)
  })

  it('allows prefetch immediately when the current SKU is already annotated — no detection was ever going to run for it', () => {
    expect(isPrefetchEligible({ ...base, currentStatus: 'annotated', currentDetectionStatus: 'idle' })).toBe(true)
  })

  it('allows prefetch immediately when the current SKU already has saved splice boundaries (resumed session) — no detection was ever going to run for it', () => {
    expect(
      isPrefetchEligible({
        ...base,
        currentSpliceBoundaries: { leftBoundary: 100, rightBoundary: 900, source: 'manual', confidence: null },
        currentDetectionStatus: 'idle',
      }),
    ).toBe(true)
  })
})
