// Phase 15.3 — the unified progress model's pure accounting function. No
// electron dependency, no timing involved beyond an injected `now`.
import { describe, expect, it } from 'vitest'
import { summarizeSandboxRunProgress } from '../apps/desktop/src/sandbox/lib/sandboxRunProgress'
import type { SandboxRunDetail } from '../apps/desktop/src/sandbox/types/sandboxRun'

function makeRun(overrides: Partial<SandboxRunDetail> = {}): SandboxRunDetail {
  return {
    id: 'run-1',
    seq: 1,
    title: 'Test Run',
    status: 'running',
    temporaryBatchId: 'batch-1',
    productTypes: ['ring', 'watch', 'necklace'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    pipelines: [
      { productType: 'ring', batchId: 'b1', status: 'completed', error: null, stage: 'editing' },
      { productType: 'watch', batchId: 'b2', status: 'running', error: null, stage: 'editing' },
      { productType: 'necklace', batchId: null, status: 'unavailable', error: 'no pipeline', stage: null },
    ],
    items: [],
    universalConfig: {},
    cancelRequested: false,
    ...overrides,
  }
}

describe('summarizeSandboxRunProgress', () => {
  it('counts pipelines by status correctly', () => {
    const progress = summarizeSandboxRunProgress(makeRun())
    expect(progress.totalPipelines).toBe(3)
    expect(progress.completed).toBe(1)
    expect(progress.running).toBe(1)
    expect(progress.unavailable).toBe(1)
    expect(progress.queued).toBe(0)
    expect(progress.failed).toBe(0)
    expect(progress.cancelled).toBe(0)
  })

  it('computes elapsed time from createdAt to now while still running', () => {
    const run = makeRun({ createdAt: '2026-01-01T00:00:00.000Z', status: 'running' })
    const now = Date.parse('2026-01-01T00:00:05.000Z')
    const progress = summarizeSandboxRunProgress(run, now)
    expect(progress.elapsedMs).toBe(5000)
    expect(progress.totalDurationMs).toBeNull() // not fabricated while still running
  })

  it('computes a real totalDurationMs once the run is terminal, using updatedAt not the current time', () => {
    const run = makeRun({
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:07.000Z',
    })
    const now = Date.parse('2026-01-01T00:05:00.000Z') // long after — must not leak into totalDurationMs
    const progress = summarizeSandboxRunProgress(run, now)
    expect(progress.totalDurationMs).toBe(7000)
    expect(progress.elapsedMs).toBe(7000)
  })

  it('never reports a negative elapsed/duration even with a clock skew edge case', () => {
    const run = makeRun({ createdAt: '2026-01-01T00:00:10.000Z', status: 'running' })
    const now = Date.parse('2026-01-01T00:00:05.000Z') // "now" before createdAt
    const progress = summarizeSandboxRunProgress(run, now)
    expect(progress.elapsedMs).toBe(0)
  })
})
