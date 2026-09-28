// Phase 15.6 — sandboxReviewData.ts: the pure Final Review assembly/
// eligibility/transition/validation logic. No electron dependency.
import { describe, expect, it } from 'vitest'
import {
  buildSandboxReviewItems,
  filterSandboxReviewItems,
  isItemActionable,
  isItemReviewable,
  isRunReviewable,
  summarizeSandboxReview,
  validateDispositionTransition,
  validateSandboxRejectionInput,
  type SandboxReviewStageSource,
} from '../apps/desktop/src/sandbox/lib/sandboxReviewData'
import { sandboxReviewItemKey } from '../apps/desktop/src/sandbox/types/sandboxReview'
import { normalizeSandboxTemporaryBatch } from '../apps/desktop/src/sandbox/lib/normalizeSandboxProductData'
import type { SandboxRunDetail, SandboxProductPipeline } from '../apps/desktop/src/sandbox/types/sandboxRun'
import type { SandboxTemporaryBatchDetail } from '../apps/desktop/src/sandbox/types/sandboxTemporaryBatch'
import type { SandboxEditor } from '../apps/desktop/src/sandbox/types/sandboxDisposition'

function makePipeline(overrides: Partial<SandboxProductPipeline> = {}): SandboxProductPipeline {
  return { productType: 'ring', batchId: 'batch-ring', status: 'completed', error: null, stage: 'editing', ...overrides }
}

function makeRun(overrides: Partial<SandboxRunDetail> = {}): SandboxRunDetail {
  return {
    id: 'run-1',
    seq: 1,
    title: 'Test Run',
    status: 'partially_completed',
    temporaryBatchId: 'batch-1',
    productTypes: ['ring', 'necklace'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    pipelines: [makePipeline(), makePipeline({ productType: 'necklace', batchId: null, status: 'unavailable', error: 'No pipeline available for this product type yet.' })],
    items: [],
    universalConfig: {},
    cancelRequested: false,
    dispositions: {},
    handoffResults: {},
    ...overrides,
  }
}

const BATCH: SandboxTemporaryBatchDetail = {
  id: 'batch-1',
  name: 'Test Batch',
  productTypes: ['ring', 'necklace'],
  imageCount: 2,
  images: [
    { sku: 'RING-1', imagePath: '/src/ring-1.png', productType: 'ring' },
    { sku: 'NECKLACE-1', imagePath: '/src/necklace-1.png', productType: 'necklace' },
  ],
}

const STAGE_SOURCES: SandboxReviewStageSource[] = [
  {
    productType: 'ring',
    pipelineCompleted: true,
    images: [{ name: 'RING-1', status: 'completed', outputPath: '/out/ring-1.png', error: null, assets: { frontFullImage: '/out/ring-1-full.png' } }],
  },
]

describe('buildSandboxReviewItems — A. raw -> review item', () => {
  it('assembles a reviewable item from the underlying stage output, carrying measurement and pending disposition', () => {
    const run = makeRun()
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })

    const ring = items.find(i => i.sku === 'RING-1')!
    expect(ring.processingStatus).toBe('completed')
    expect(ring.outputPath).toBe('/out/ring-1.png')
    expect(ring.sourceImagePath).toBe('/src/ring-1.png')
    expect(ring.disposition.state).toBe('pending')
    expect(ring.postProcessingComplete).toBe(true)
    // P. Editing complete + post-processing complete + a real output path
    // = reviewable (Phase 15.7 section 15's positive case).
    expect(isItemReviewable(ring)).toBe(true)
  })

  it('final hardening phase regression — matches a StageImageRecord whose name carries the materialized file extension (Ring/Bracelet/Earring\'s real runner.py convention), not just a bare name (Watch\'s convention)', () => {
    // A real end-to-end run (Watch + Ring + Bracelet + Earring through the
    // genuine Python runners, no mocks) surfaced this: Ring & Bracelet's
    // real runner reports the per-image event's "name" as the materialized
    // SOURCE filename it was given — "SKU.png" — not the bare SKU Watch's
    // own dispatch uses. The old exact-match comparison silently treated
    // every Ring/Bracelet/Earring item as "editing failed" even when it
    // had genuinely succeeded, which no prior test caught because every
    // mock fixture (including this file's own STAGE_SOURCES above) had
    // happened to use a bare name for every product alike.
    const run = makeRun()
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const stageSources: SandboxReviewStageSource[] = [
      { productType: 'ring', pipelineCompleted: true, images: [{ name: 'RING-1.png', status: 'completed', outputPath: '/out/ring-1.png', error: null }] },
    ]
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources })
    const ring = items.find(i => i.sku === 'RING-1')!
    expect(ring.processingStatus).toBe('completed')
    expect(ring.outputPath).toBe('/out/ring-1.png')
    expect(isItemReviewable(ring)).toBe(true)
  })

  it('L/unavailable — Necklace stays visible with an unavailable status and no output, never a fabricated success', () => {
    const run = makeRun()
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })

    const necklace = items.find(i => i.sku === 'NECKLACE-1')!
    expect(necklace.processingStatus).toBe('unavailable')
    expect(necklace.outputPath).toBeNull()
    expect(isItemReviewable(necklace)).toBe(false)
  })

  it('B/Q/R — items with no matching stage output (editing itself failed) are visible but not reviewable', () => {
    const run = makeRun({ pipelines: [makePipeline({ status: 'failed', error: 'ring failed' })] })
    const normalizedBatch = normalizeSandboxTemporaryBatch({ ...BATCH, productTypes: ['ring'], images: [BATCH.images[0]] })
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: [] })

    const ring = items[0]
    expect(ring.processingStatus).toBe('failed')
    expect(isItemReviewable(ring)).toBe(false)
    expect(isItemActionable(ring)).toBe(false)
  })

  it('reads an existing disposition back from the run, keyed by product+sku (not sku alone)', () => {
    const run = makeRun({
      dispositions: {
        [sandboxReviewItemKey('ring', 'RING-1')]: { state: 'approved', reason: null, instructions: null, assignedEditor: null, decidedAt: '2026-01-01T00:01:00.000Z' },
      },
    })
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })
    expect(items.find(i => i.sku === 'RING-1')!.disposition.state).toBe('approved')
  })

  it('Phase 15.7 — an Editing-only success is honestly represented as postProcessingComplete=false and is NOT reviewable, now that real post-processing scripts exist', () => {
    const run = makeRun({ pipelines: [makePipeline({ status: 'failed', error: 'ring / compressorNew / post-processing failed' })] })
    const normalizedBatch = normalizeSandboxTemporaryBatch({ ...BATCH, productTypes: ['ring'], images: [BATCH.images[0]] })
    const stageSources: SandboxReviewStageSource[] = [{ ...STAGE_SOURCES[0], pipelineCompleted: false }]
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources })

    const ring = items[0]
    expect(ring.processingStatus).toBe('completed') // Editing succeeded
    expect(ring.postProcessingComplete).toBe(false) // but Post Processing did not
    // Phase 15.6's interim "Editing success alone is reviewable" rule was
    // approved only because zero real post-processing scripts existed
    // anywhere in the repository at the time. Now that real scripts exist
    // (Phase 15.7), a compulsory script failing/not-yet-run must block
    // review — approving un-post-processed output would be a false
    // success. See isItemReviewable's own Phase 15.7 doc comment.
    expect(isItemReviewable(ring)).toBe(false)
  })
})

describe('isRunReviewable — run-level eligibility', () => {
  it('not reviewable while running/validating/draft', () => {
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const items = buildSandboxReviewItems({ run: makeRun(), normalizedBatch, stageSources: STAGE_SOURCES })
    for (const status of ['draft', 'validating', 'running'] as const) {
      expect(isRunReviewable(makeRun({ status }), items)).toBe(false)
    }
  })

  it('never reviewable when cancelled, even with some completed items', () => {
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const items = buildSandboxReviewItems({ run: makeRun({ status: 'cancelled' }), normalizedBatch, stageSources: STAGE_SOURCES })
    expect(isRunReviewable(makeRun({ status: 'cancelled' }), items)).toBe(false)
  })

  it('failed is reviewable as long as at least one item has real output (approved interpretation)', () => {
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const run = makeRun({ status: 'failed' })
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })
    expect(isRunReviewable(run, items)).toBe(true)
  })

  it('failed is NOT reviewable when literally nothing produced output', () => {
    const run = makeRun({ status: 'failed', pipelines: [makePipeline({ status: 'failed' })] })
    const normalizedBatch = normalizeSandboxTemporaryBatch({ ...BATCH, productTypes: ['ring'], images: [BATCH.images[0]] })
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: [] })
    expect(isRunReviewable(run, items)).toBe(false)
  })

  it('completed/partially_completed are reviewable', () => {
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    for (const status of ['completed', 'partially_completed'] as const) {
      const run = makeRun({ status })
      const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })
      expect(isRunReviewable(run, items)).toBe(true)
    }
  })
})

describe('T. disposition vs processing status separation', () => {
  it('a completed item can independently be pending, approved, or rejected', () => {
    for (const state of ['pending', 'approved', 'rejected'] as const) {
      const run = makeRun({
        dispositions:
          state === 'pending'
            ? {}
            : { [sandboxReviewItemKey('ring', 'RING-1')]: { state, reason: state === 'rejected' ? 'bad crop' : null, instructions: null, assignedEditor: null, decidedAt: 'x' } },
      })
      const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
      const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })
      const ring = items.find(i => i.sku === 'RING-1')!
      expect(ring.processingStatus).toBe('completed') // unchanged regardless of disposition
      expect(ring.disposition.state).toBe(state)
    }
  })
})

describe('summarizeSandboxReview / filterSandboxReviewItems — S. filtering, U-adjacent counting', () => {
  const run = makeRun()
  const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
  const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })

  it('summarizes pending/approved/rejected/notReviewable correctly', () => {
    const summary = summarizeSandboxReview(items)
    expect(summary.total).toBe(2)
    expect(summary.pending).toBe(1) // ring
    expect(summary.notReviewable).toBe(1) // necklace, unavailable
  })

  it('product filter narrows to the requested product type only', () => {
    expect(filterSandboxReviewItems(items, 'all', 'ring')).toHaveLength(1)
    expect(filterSandboxReviewItems(items, 'all', 'necklace')).toHaveLength(1)
    expect(filterSandboxReviewItems(items, 'all', 'watch')).toHaveLength(0)
  })

  it('"failed" status filter includes not-reviewable items (failed + unavailable), never reviewable ones', () => {
    const failedFiltered = filterSandboxReviewItems(items, 'failed', 'all')
    expect(failedFiltered.map(i => i.sku)).toEqual(['NECKLACE-1'])
  })

  it('"pending" status filter only includes reviewable+pending items', () => {
    expect(filterSandboxReviewItems(items, 'pending', 'all').map(i => i.sku)).toEqual(['RING-1'])
  })
})

describe('isItemActionable — Q/R/U safety', () => {
  it('an unavailable item is never actionable', () => {
    const run = makeRun()
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })
    expect(isItemActionable(items.find(i => i.sku === 'NECKLACE-1')!)).toBe(false)
  })

  it('a failed (attempted-but-unsuccessful) item is never actionable', () => {
    const run = makeRun({ pipelines: [makePipeline({ status: 'failed' })] })
    const normalizedBatch = normalizeSandboxTemporaryBatch({ ...BATCH, productTypes: ['ring'], images: [BATCH.images[0]] })
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: [] })
    expect(isItemActionable(items[0])).toBe(false)
  })

  it('an already-approved item is no longer actionable (no silent re-decision)', () => {
    const run = makeRun({
      dispositions: { [sandboxReviewItemKey('ring', 'RING-1')]: { state: 'approved', reason: null, instructions: null, assignedEditor: null, decidedAt: 'x' } },
    })
    const normalizedBatch = normalizeSandboxTemporaryBatch(BATCH)
    const items = buildSandboxReviewItems({ run, normalizedBatch, stageSources: STAGE_SOURCES })
    expect(isItemActionable(items.find(i => i.sku === 'RING-1')!)).toBe(false)
  })
})

describe('validateDispositionTransition — M. duplicate transition prevention', () => {
  it('pending -> approved and pending -> rejected are valid', () => {
    expect(validateDispositionTransition('pending', 'approved').ok).toBe(true)
    expect(validateDispositionTransition('pending', 'rejected').ok).toBe(true)
  })

  it('an already-approved or already-rejected item cannot transition again', () => {
    expect(validateDispositionTransition('approved', 'rejected').ok).toBe(false)
    expect(validateDispositionTransition('rejected', 'approved').ok).toBe(false)
    expect(validateDispositionTransition('approved', 'approved').ok).toBe(false)
  })
})

describe('validateSandboxRejectionInput — F/G/H', () => {
  const editor: SandboxEditor = { id: 'e1', name: 'Editor One' }

  it('F: requires a non-empty reason', () => {
    expect(validateSandboxRejectionInput({ reason: '', editor }).ok).toBe(false)
    expect(validateSandboxRejectionInput({ reason: '   ', editor }).ok).toBe(false)
    expect(validateSandboxRejectionInput({ reason: 'bad crop', editor }).ok).toBe(true)
  })

  it('G: requires an editor', () => {
    expect(validateSandboxRejectionInput({ reason: 'bad crop', editor: null }).ok).toBe(false)
  })

  it('H: instructions are optional — omitting them is still valid', () => {
    const result = validateSandboxRejectionInput({ reason: 'bad crop', editor, instructions: null })
    expect(result.ok).toBe(true)
  })
})
