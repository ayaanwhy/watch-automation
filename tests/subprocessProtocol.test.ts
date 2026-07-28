import { describe, it, expect } from 'vitest'
import {
  applyNdjsonEvent,
  classifyExit,
  reconcileImages,
  snapshotProgress,
  EXIT_CANCELLED,
  type JobBookkeeping,
} from '../apps/desktop/electron/services/subprocessProtocol.js'
import type { StageImageRecord } from '../apps/desktop/src/types/batch.js'

function freshJob(): JobBookkeeping {
  return {
    succeeded: 0,
    failed: 0,
    totalDurationMs: 0,
    fatalError: null,
    allImages: [],
    imageResults: new Map(),
  }
}

// Mirrors preprocessHandlers.ts's mapCompleteEvent exactly — used across
// these tests so they exercise the same shape the real pipeline produces.
function mapComplete(event: Record<string, unknown>): Omit<StageImageRecord, 'name'> {
  return {
    status: 'completed',
    outputPath: (event['output'] as string) ?? null,
    error: null,
    durationMs: (event['duration_ms'] as number) ?? null,
  }
}

describe('applyNdjsonEvent', () => {
  it('captures the done summary', () => {
    const job = freshJob()
    applyNdjsonEvent(job, { type: 'done', succeeded: 3, failed: 1, total_duration_ms: 4200 }, mapComplete)
    expect(job.succeeded).toBe(3)
    expect(job.failed).toBe(1)
    expect(job.totalDurationMs).toBe(4200)
  })

  it('records a fatal error', () => {
    const job = freshJob()
    applyNdjsonEvent(job, { type: 'fatal', error: 'model load failed' }, mapComplete)
    expect(job.fatalError).toBe('model load failed')
  })

  it('defaults a fatal event with no error field to a generic message', () => {
    const job = freshJob()
    applyNdjsonEvent(job, { type: 'fatal' }, mapComplete)
    expect(job.fatalError).toBe('Unknown fatal error')
  })

  it('captures the announced image list from start', () => {
    const job = freshJob()
    applyNdjsonEvent(job, { type: 'start', total: 2, images: ['a.png', 'b.png'] }, mapComplete)
    expect(job.allImages).toEqual(['a.png', 'b.png'])
  })

  it('maps a complete event through the pipeline-specific mapper', () => {
    const job = freshJob()
    applyNdjsonEvent(job, { type: 'complete', image: 'a.png', output: '/out/a.png', duration_ms: 120 }, mapComplete)
    expect(job.imageResults.get('a.png')).toEqual({
      status: 'completed',
      outputPath: '/out/a.png',
      error: null,
      durationMs: 120,
    })
  })

  it('records a per-image error event as failed', () => {
    const job = freshJob()
    applyNdjsonEvent(job, { type: 'error', image: 'a.png', error: 'corrupt file', fatal: false }, mapComplete)
    expect(job.imageResults.get('a.png')).toEqual({
      status: 'failed',
      outputPath: null,
      error: 'corrupt file',
      durationMs: null,
    })
  })

  it('ignores unrecognized event types without throwing', () => {
    const job = freshJob()
    expect(() => applyNdjsonEvent(job, { type: 'heartbeat', elapsed_ms: 500 }, mapComplete)).not.toThrow()
  })
})

describe('classifyExit', () => {
  it('classifies EXIT_CANCELLED as a user cancellation, not a failure', () => {
    const result = classifyExit(EXIT_CANCELLED, null)
    expect(result.cancelledByUser).toBe(true)
    expect(result.fatalError).toBeNull()
  })

  it('classifies a clean exit (0) as success with no synthesized error', () => {
    const result = classifyExit(0, null)
    expect(result.cancelledByUser).toBe(false)
    expect(result.fatalError).toBeNull()
  })

  it('preserves an existing fatal error on a normal failing exit', () => {
    const result = classifyExit(1, 'model load failed')
    expect(result.cancelledByUser).toBe(false)
    expect(result.fatalError).toBe('model load failed')
  })

  // Phase 11A regression coverage: a crash/segfault/OOM-kill exits non-zero
  // without ever emitting a 'fatal' NDJSON event — this must not be
  // classified as success.
  it('synthesizes a fatal error for an unexpected non-zero exit with no fatal event', () => {
    const result = classifyExit(139, null)
    expect(result.cancelledByUser).toBe(false)
    expect(result.fatalError).toBe('Process exited unexpectedly with code 139')
  })

  it('synthesizes a fatal error for a signal-killed exit (code null)', () => {
    const result = classifyExit(null, null)
    expect(result.cancelledByUser).toBe(false)
    expect(result.fatalError).toBe('Process exited unexpectedly with code null')
  })
})

describe('reconcileImages', () => {
  it('passes through images that reached a terminal event untouched', () => {
    const results = new Map<string, Omit<StageImageRecord, 'name'>>([
      ['a.png', { status: 'completed', outputPath: '/out/a.png', error: null, durationMs: 100 }],
    ])
    const { images, counts } = reconcileImages(['a.png'], results, false)
    expect(images).toEqual([{ name: 'a.png', status: 'completed', outputPath: '/out/a.png', error: null, durationMs: 100 }])
    expect(counts).toEqual({ total: 1, succeeded: 1, failed: 0, cancelled: 0, needsFixing: 0 })
  })

  // Phase 10G regression coverage: an image announced by 'start' but never
  // reaching a terminal event (cooperative cancellation stopped the runner
  // between images) must still be counted, not silently dropped.
  it('fills in a never-completed image as cancelled when the batch was cancelled', () => {
    const { images, counts } = reconcileImages(['a.png', 'b.png'], new Map(), true)
    expect(images).toEqual([
      { name: 'a.png', status: 'cancelled', outputPath: null, error: null, durationMs: null },
      { name: 'b.png', status: 'cancelled', outputPath: null, error: null, durationMs: null },
    ])
    expect(counts).toEqual({ total: 2, succeeded: 0, failed: 0, cancelled: 2, needsFixing: 0 })
  })

  it('fills in a never-completed image as failed when the batch was not cancelled', () => {
    const { images, counts } = reconcileImages(['a.png'], new Map(), false)
    expect(images).toEqual([{ name: 'a.png', status: 'failed', outputPath: null, error: 'Not completed', durationMs: null }])
    expect(counts).toEqual({ total: 1, succeeded: 0, failed: 1, cancelled: 0, needsFixing: 0 })
  })

  it('derives counts from the reconciled array, not just succeeded/failed images', () => {
    const results = new Map<string, Omit<StageImageRecord, 'name'>>([
      ['a.png', { status: 'completed', outputPath: '/out/a.png', error: null, durationMs: 100 }],
      ['b.png', { status: 'failed', outputPath: null, error: 'boom', durationMs: null }],
    ])
    const { counts } = reconcileImages(['a.png', 'b.png', 'c.png'], results, true)
    expect(counts).toEqual({ total: 3, succeeded: 1, failed: 1, cancelled: 1, needsFixing: 0 })
  })
})

// Phase 11.5D — the mid-run counterpart to reconcileImages, used to persist
// progress incrementally rather than only at process close.
describe('snapshotProgress', () => {
  it('reports an empty snapshot before any image has completed', () => {
    const { images, counts } = snapshotProgress(['a.png', 'b.png'], new Map())
    expect(images).toEqual([])
    expect(counts).toEqual({ total: 2, succeeded: 0, failed: 0, cancelled: 0, needsFixing: 0 })
  })

  it('includes only images that have actually reached a terminal event, unlike reconcileImages', () => {
    const results = new Map<string, Omit<StageImageRecord, 'name'>>([
      ['a.png', { status: 'completed', outputPath: '/out/a.png', error: null, durationMs: 100 }],
    ])
    const { images, counts } = snapshotProgress(['a.png', 'b.png', 'c.png'], results)
    expect(images).toEqual([{ name: 'a.png', status: 'completed', outputPath: '/out/a.png', error: null, durationMs: 100 }])
    // total still reflects the full announced batch, even though b/c haven't finished.
    expect(counts).toEqual({ total: 3, succeeded: 1, failed: 0, cancelled: 0, needsFixing: 0 })
  })

  it('never reports a cancelled count — nothing is cancelled until the job actually ends', () => {
    const results = new Map<string, Omit<StageImageRecord, 'name'>>([
      ['a.png', { status: 'completed', outputPath: '/out/a.png', error: null, durationMs: 100 }],
      ['b.png', { status: 'failed', outputPath: null, error: 'boom', durationMs: null }],
    ])
    const { counts } = snapshotProgress(['a.png', 'b.png'], results)
    expect(counts.cancelled).toBe(0)
  })
})
