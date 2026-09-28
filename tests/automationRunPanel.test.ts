// The progress panel is a pure VIEW over the engine's persisted job state:
// this renders it (server-side, no DOM/Electron) from job states shaped
// exactly like the engine's, to prove what a user sees — live counts, the
// current image/stage, batch-global post-processing wording, run/product/
// image-level structured errors with actions and expandable technical
// details, and the Review/Retry/Cancel actions. Logic (ETA etc.) is tested
// on the pure functions; this only guards the wiring to real state.
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SandboxRunPanel } from '../apps/desktop/src/sandbox/components/SandboxRunPanel'
import { makeAutomationError } from '../apps/desktop/src/sandbox/types/automationError'

const stage = (id: string, label: string, phase: string, status: string, batchGlobal = false) => ({ id, label, phase, status, ...(batchGlobal ? { batchGlobal } : {}) })

function job(overrides: any = {}): any {
  const now = Date.now()
  return {
    id: 'run-1', title: 'Test Batch', status: 'running', cancelRequested: false,
    createdAt: new Date(now - 60_000).toISOString(), startedAt: new Date(now - 60_000).toISOString(), finishedAt: null, failure: null,
    pipelines: [
      { productType: 'ring', status: 'running', activity: 'Running compressorNew — batch post-processing', error: null, failure: null },
      { productType: 'watch', status: 'running', activity: 'Editing', error: null, failure: null },
      { productType: 'necklace', status: 'unavailable', activity: null, error: 'Necklace has no processing pipeline yet.', failure: null },
    ],
    items: [
      { sku: 'RING-1', productType: 'ring', status: 'running', stage: 'compressorNew', error: null, failure: null, stages: [stage('editing', 'Ring Editing', 'editing', 'done'), stage('pp:compressorNew', 'compressorNew', 'post_processing', 'running', true)] },
      { sku: 'RING-2', productType: 'ring', status: 'completed', stage: null, error: null, failure: null, stages: [] },
      { sku: 'WATCH-1', productType: 'watch', status: 'running', stage: 'AI Boundary Detection', error: null, failure: null, stages: [stage('ai_detection', 'AI Boundary Detection', 'editing', 'running'), stage('editing', 'Watch Processing', 'editing', 'pending')] },
      { sku: 'WATCH-2', productType: 'watch', status: 'failed', stage: null, error: 'x', stages: [stage('ai_detection', 'AI Boundary Detection', 'editing', 'failed')],
        failure: makeAutomationError('WATCH_BOUNDARY_UNAVAILABLE', { sku: 'WATCH-2', productType: 'watch', technicalMessage: 'fetch failed (HTTP 503)' }) },
      { sku: 'NECK-1', productType: 'necklace', status: 'unavailable', stage: null, error: 'Necklace has no processing pipeline yet.', failure: null, stages: [] },
    ],
    ...overrides,
  }
}

const render = (run: any, props: any = {}) => renderToStaticMarkup(createElement(SandboxRunPanel, { run, onCancel: () => {}, ...props }))

describe('SandboxRunPanel', () => {
  it('shows live counts, the current image + stage, per-product counts, and batch post-processing wording — no fabricated percent per image', () => {
    const html = render(job())
    expect(html).toContain('<strong>1 / 4</strong>') // completed / images in runnable products (necklace excluded)
    expect(html).toContain('images complete')
    expect(html).toContain('1 failed')
    expect(html).toContain('1 unavailable')
    expect(html).toContain('RING-1') // current image
    expect(html).toContain('AI Boundary Detection') // its current stage
    expect(html).toContain('Running compressorNew — batch post-processing')
    expect(html).toContain('1 / 2') // Ring 1/2
    expect(html).toContain('0 / 2 · 1 failed') // Watch
    expect(html).toContain('Cancel Run')
    expect(html).not.toContain('Review Results')
    // Rate/ETA are shown because they ARE calculable here: 3 images have
    // finished per-image work (1 completed, 1 failed, 1 past editing) in
    // 60s, 1 remains — and the wording says the ETA covers image processing
    // only (batch post-processing time is unknown).
    expect(html).toContain('3.0 images/min')
    expect(html).toContain('~20s remaining (image processing)')
    // The only percentage anywhere is the overall images-finished bar width;
    // there are no per-image / per-script percentages.
    expect(html.replace(/style="width:\d+%"/, '')).not.toMatch(/\d+%/)
  })

  it('shows no rate/ETA when there is too little data to compute one', () => {
    const html = render(job({ items: [{ sku: 'A', productType: 'ring', status: 'running', stage: 'Ring Editing', error: null, failure: null, stages: [] }, { sku: 'B', productType: 'ring', status: 'queued', error: null, failure: null, stages: [] }] }))
    expect(html).not.toContain('images/min')
    expect(html).not.toContain('remaining')
  })

  it('renders an image-level failure with WHAT/WHERE, the action, retryability, and technical detail only behind an expander', () => {
    const html = render(job())
    expect(html).toContain('Watch boundary detection is currently unavailable.')
    expect(html).toContain('Check the Watch AI service connection and retry.')
    expect(html).toContain('AI Detection')
    expect(html).toContain('Retryable')
    expect(html).toContain('<summary>Technical details</summary>')
    expect(html).toMatch(/<details[^>]*><summary>Technical details<\/summary><pre>[^<]*fetch failed \(HTTP 503\)/)
    // The technical text is never the primary message.
    expect(html.replace(/<pre>[\s\S]*?<\/pre>/g, '')).not.toContain('fetch failed')
  })

  it('shows the per-image stage chain with completed/running/pending marks', () => {
    const html = render(job())
    expect(html).toContain('✓')
    expect(html).toContain('→')
    expect(html).toContain('○')
    expect(html).toContain('(batch)') // a running batch-global stage is labelled as batch
  })

  it('a failed run shows the run-level structured error and offers Retry Run (and Review Results); no Cancel', () => {
    const failure = makeAutomationError('PYTHON_UNAVAILABLE')
    const html = render(
      job({ status: 'failed', failure, finishedAt: new Date().toISOString(), pipelines: [{ productType: 'ring', status: 'failed', activity: null, error: failure.message, failure: { ...failure, productType: 'ring' } }], items: [] }),
      { onRetry: () => {}, onReview: () => {} },
    )
    expect(html).toContain('The Python runtime required for image processing is unavailable.')
    expect(html).toContain('Install or configure the required Python environment and retry.')
    expect(html).toContain('Retry Run')
    expect(html).toContain('Review Results')
    expect(html).not.toContain('Cancel Run')
  })

  it('a completed run offers Review Results but not Retry Run', () => {
    const html = render(job({ status: 'completed', finishedAt: new Date().toISOString(), items: [{ sku: 'A', productType: 'ring', status: 'completed', stage: null, error: null, failure: null, stages: [] }], pipelines: [{ productType: 'ring', status: 'completed', activity: null, error: null, failure: null }] }), { onRetry: () => {}, onReview: () => {} })
    expect(html).toContain('<strong>1 / 1</strong>')
    expect(html).toContain('Review Results')
    expect(html).not.toContain('Retry Run')
  })

  it('renders records persisted before the automation-engine pass (no stages/failure/startedAt fields) without crashing', () => {
    const legacy = { id: 'old', title: 'Old', status: 'completed', cancelRequested: false, createdAt: new Date().toISOString(), pipelines: [{ productType: 'ring', status: 'completed', error: null }], items: [] }
    expect(() => render(legacy)).not.toThrow()
  })
})

describe('SandboxRunPanel — Retry Image', () => {
  const failure = makeAutomationError('WATCH_BOUNDARY_UNAVAILABLE', { sku: 'W-1', productType: 'watch' })
  const watchRun = (item: any, pipelineStatus = 'completed', runStatus = 'partially_completed') => job({
    status: runStatus, finishedAt: new Date().toISOString(),
    pipelines: [{ productType: 'watch', status: pipelineStatus, activity: null, error: null, failure: null }],
    items: [item],
  })
  const failedItem = (extra: any = {}) => ({ sku: 'W-1', productType: 'watch', status: 'failed', stage: null, error: 'x', failure, stages: [stage('ai_detection', 'AI Boundary Detection', 'editing', 'failed')], ...extra })

  it('a failed, retryable image offers "Retry Image" (when its product is not mid-pipeline and a handler exists)', () => {
    expect(render(watchRun(failedItem()), { onRetryImage: async () => null })).toContain('Retry Image')
  })

  it('no button for: no handler, a running/queued product, a non-retryable failure, a completed image', () => {
    expect(render(watchRun(failedItem()))).not.toContain('Retry Image')
    expect(render(watchRun(failedItem(), 'running', 'running'), { onRetryImage: async () => null })).not.toContain('Retry Image')
    const fixFirst = makeAutomationError('MISSING_GEMSTONE_SHAPE', { sku: 'W-1', productType: 'watch' })
    expect(render(watchRun(failedItem({ failure: fixFirst })), { onRetryImage: async () => null })).not.toContain('Retry Image')
    expect(render(watchRun({ sku: 'W-1', productType: 'watch', status: 'completed', stage: null, error: null, failure: null, stages: [] }), { onRetryImage: async () => null })).not.toContain('Retry Image')
  })

  it('while an image is being retried it shows live progress like any running image (attempt label, current stage, no Retry button, no stale error) and the run is "in progress"', () => {
    const html = render(
      watchRun({
        sku: 'W-1', productType: 'watch', status: 'running', stage: 'AI Boundary Detection', error: null, failure: null, attempt: 2,
        history: [{ attempt: 1, failure, failedAt: new Date().toISOString(), restartedFrom: 'editing' }],
        stages: [stage('ai_detection', 'AI Boundary Detection', 'editing', 'running'), stage('editing', 'Watch Processing', 'editing', 'pending')],
      }),
      { onRetryImage: async () => null, onReview: () => {}, onRetry: () => {} },
    )
    expect(html).not.toContain('Retry Image')
    expect(html).toContain('attempt 2')
    expect(html).toContain('AI Boundary Detection')
    expect(html).toContain('Retrying image…')
    // The live attempt shows no stale error notice...
    expect(html.replace(/<details class="[^"]*history[^"]*">[\s\S]*?<\/details>/, '')).not.toContain('Watch boundary detection is currently unavailable.')
    expect(html).toContain('Previous attempts (1)') // ...but the earlier failure stays in the history
    expect(html).not.toContain('Review Results')
    expect(html).toContain('Cancel Run')
  })

  it('a repeat failure shows the NEW structured error with the earlier attempts kept, and offers Retry Image again', () => {
    const older = makeAutomationError('WATCH_BOUNDARY_TIMEOUT', { sku: 'W-1', productType: 'watch' })
    const html = render(
      watchRun(failedItem({ attempt: 2, history: [{ attempt: 1, failure: older, failedAt: new Date().toISOString(), restartedFrom: 'editing' }] })),
      { onRetryImage: async () => null },
    )
    expect(html).toContain('Watch boundary detection is currently unavailable.') // current failure
    expect(html).toContain('attempt 2')
    expect(html).toContain('Previous attempts (1)')
    expect(html).toContain(older.message)
    expect(html).toContain('restarted from editing')
    expect(html).toContain('Retry Image')
  })

  it('a retried image that succeeded shows no error, keeps its history, and the completed run offers Review Results', () => {
    const html = render(
      watchRun({ sku: 'W-1', productType: 'watch', status: 'completed', stage: null, error: null, failure: null, attempt: 2, stages: [], history: [{ attempt: 1, failure, failedAt: null, restartedFrom: 'editing' }] }, 'completed', 'completed'),
      { onRetryImage: async () => null, onReview: () => {} },
    )
    expect(html).toContain('Review Results')
    expect(html).toContain('Previous attempts (1)')
    expect(html).not.toContain('Retry Image')
  })
})
