import { describe, it, expect } from 'vitest'
import {
  applyStagePatch,
  computeCurrentStage,
  computeNextStage,
  createBatchDetail,
  deriveBatchStatus,
  formatBatchTitle,
  summarize,
} from '../apps/desktop/electron/services/batchModel'
import type { BatchDetailRecord } from '../apps/desktop/src/types/batch'

const NOW = '2026-07-04T12:00:00.000Z'

function fullBatch(): BatchDetailRecord {
  return createBatchDetail({
    id: 'batch-1',
    seq: 7,
    sourceDir: '/src',
    pipeline: ['preprocessing', 'watch'],
    now: NOW,
  })
}

describe('formatBatchTitle', () => {
  it('zero-pads to three digits', () => {
    expect(formatBatchTitle(7)).toBe('Batch 007')
    expect(formatBatchTitle(123)).toBe('Batch 123')
  })
})

describe('createBatchDetail', () => {
  it('seeds a draft with stages from the pipeline and the source as first input', () => {
    const b = fullBatch()
    expect(b.title).toBe('Batch 007')
    expect(b.status).toBe('draft')
    expect(b.stages.map(s => s.type)).toEqual(['preprocessing', 'watch'])
    expect(b.stages.every(s => s.status === 'not_started')).toBe(true)
    expect(b.stages[0].inputDir).toBe('/src')
    expect(b.stages[1].inputDir).toBe('') // set when the previous stage completes
  })

  it('derives currentStage=first stage, nextStage=successor', () => {
    const b = fullBatch()
    expect(b.currentStage).toBe('preprocessing')
    expect(b.nextStage).toBe('watch')
  })

  it('honors a custom title but falls back to the auto name when blank', () => {
    expect(createBatchDetail({ id: 'x', seq: 3, sourceDir: '/s', pipeline: ['watch'], title: 'My Batch', now: NOW }).title).toBe('My Batch')
    expect(createBatchDetail({ id: 'x', seq: 3, sourceDir: '/s', pipeline: ['watch'], title: '   ', now: NOW }).title).toBe('Batch 003')
  })
})

describe('computeCurrentStage / computeNextStage', () => {
  const pipeline = ['preprocessing', 'watch'] as const

  it('a running stage always wins as current', () => {
    let b = fullBatch()
    b = applyStagePatch(b, 'preprocessing', { status: 'completed' }, NOW)
    b = applyStagePatch(b, 'watch', { status: 'running' }, NOW)
    expect(computeCurrentStage([...pipeline], b.stages)).toBe('watch')
    expect(b.currentStage).toBe('watch')
  })

  it('otherwise current is the first non-completed stage', () => {
    let b = fullBatch()
    b = applyStagePatch(b, 'preprocessing', { status: 'completed' }, NOW)
    expect(b.currentStage).toBe('watch')
    expect(b.nextStage).toBe(null)
  })

  it('current is null when every stage is completed', () => {
    let b = fullBatch()
    b = applyStagePatch(b, 'preprocessing', { status: 'completed' }, NOW)
    b = applyStagePatch(b, 'watch', { status: 'completed' }, NOW)
    expect(b.currentStage).toBe(null)
    expect(b.nextStage).toBe(null)
  })

  it('nextStage is null past the end of the pipeline', () => {
    expect(computeNextStage(['preprocessing', 'watch'], 'watch')).toBe(null)
    expect(computeNextStage(['preprocessing', 'watch'], 'preprocessing')).toBe('watch')
  })
})

describe('deriveBatchStatus', () => {
  it('draft when nothing started', () => {
    expect(fullBatch().status).toBe('draft')
  })

  it('in_progress when a stage is running', () => {
    const b = applyStagePatch(fullBatch(), 'preprocessing', { status: 'running' }, NOW)
    expect(b.status).toBe('in_progress')
  })

  it('in_progress when a stage is completed but others remain', () => {
    const b = applyStagePatch(fullBatch(), 'preprocessing', { status: 'completed' }, NOW)
    expect(b.status).toBe('in_progress')
  })

  it('completed only when every stage is completed', () => {
    let b = applyStagePatch(fullBatch(), 'preprocessing', { status: 'completed' }, NOW)
    b = applyStagePatch(b, 'watch', { status: 'completed' }, NOW)
    expect(b.status).toBe('completed')
  })

  it('failed takes precedence over cancelled (no running stage)', () => {
    let b = applyStagePatch(fullBatch(), 'preprocessing', { status: 'failed' }, NOW)
    b = applyStagePatch(b, 'watch', { status: 'cancelled' }, NOW)
    expect(b.status).toBe('failed')
  })
})

describe('applyStagePatch', () => {
  it('stamps startedAt on first run and completedAt on terminal status', () => {
    let b = applyStagePatch(fullBatch(), 'preprocessing', { status: 'running' }, '2026-07-04T12:00:00.000Z')
    const started = b.stages[0].startedAt
    expect(started).toBe('2026-07-04T12:00:00.000Z')
    b = applyStagePatch(b, 'preprocessing', { status: 'completed', counts: { total: 5, succeeded: 5, failed: 0, cancelled: 0 } }, '2026-07-04T12:05:00.000Z')
    expect(b.stages[0].startedAt).toBe('2026-07-04T12:00:00.000Z') // unchanged
    expect(b.stages[0].completedAt).toBe('2026-07-04T12:05:00.000Z')
    expect(b.durationMs).toBe(5 * 60 * 1000)
  })

  it('merges config and ref rather than replacing them', () => {
    let b = applyStagePatch(fullBatch(), 'preprocessing', { config: { scaleFactor: 2 } }, NOW)
    b = applyStagePatch(b, 'preprocessing', { config: { objectType: 'watch' }, ref: { sessionKey: 'abc' } }, NOW)
    expect(b.stages[0].config).toEqual({ scaleFactor: 2, objectType: 'watch' })
    expect(b.stages[0].ref).toEqual({ sessionKey: 'abc' })
  })

  it('rolls the batch counts up from the current stage', () => {
    const b = applyStagePatch(fullBatch(), 'preprocessing', { status: 'running', counts: { total: 10, succeeded: 3, failed: 1, cancelled: 0 } }, NOW)
    expect(b.counts).toEqual({ total: 10, succeeded: 3, failed: 1, cancelled: 0 })
  })
})

describe('summarize', () => {
  it('drops per-stage detail but keeps derived fields', () => {
    const b = fullBatch()
    const summary = summarize(b)
    expect('stages' in summary).toBe(false)
    expect(summary.stageStatuses).toEqual([
      { type: 'preprocessing', status: 'not_started' },
      { type: 'watch', status: 'not_started' },
    ])
    expect(summary.currentStage).toBe('preprocessing')
  })
})
