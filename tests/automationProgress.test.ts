// Progress model: stage planning from real config, pure item-state
// transitions, the buffered recorder, and the image-level summary (counts,
// per-product, and an ETA that only exists when it genuinely can).
import { describe, expect, it, vi } from 'vitest'
import { planItemStages, preprocessingConfigFor, stageIdsOfPhase } from '../apps/desktop/electron/sandbox/engine/stagePlan'
import { JobProgressRecorder, cancelItem, completeItem, failItem, setItemStage } from '../apps/desktop/electron/sandbox/engine/progress'
import { summarizeImageProgress } from '../apps/desktop/src/sandbox/lib/sandboxRunProgress'
import { createInitialUniversalConfig } from '../apps/desktop/src/sandbox/types/sandboxUniversalConfig'
import { makeAutomationError } from '../apps/desktop/src/sandbox/types/automationError'
import type { SandboxRunDetail, SandboxRunItemState } from '../apps/desktop/src/sandbox/types/sandboxRun'

const batch = (productTypes: any[]) => ({ id: 'b', name: 'B', productTypes, imageCount: 0, images: [] }) as any
const NOW = '2026-01-01T00:00:00.000Z'

function item(overrides: Partial<SandboxRunItemState> & { sku: string }, stages = planItemStages('ring', createInitialUniversalConfig(batch(['ring'])))): SandboxRunItemState {
  return { productType: 'ring', status: 'queued', error: null, failure: null, stage: null, stages: structuredClone(stages), ...overrides }
}

describe('planItemStages — derived from the real configuration, never invented', () => {
  it('default (Background Removal + Upscaling) Ring: Upscaling -> Background Removal -> editing -> compulsory scripts, in canonical order', () => {
    const stages = planItemStages('ring', createInitialUniversalConfig(batch(['ring'])))
    expect(stages.map(s => s.label)).toEqual(['Upscaling', 'Background Removal', 'Ring Editing', 'imageResizeNew', 'compressorNew', 'makeCompareRB'])
    expect(stages.filter(s => s.phase === 'post_processing').every(s => s.batchGlobal)).toBe(true)
  })

  it('only configured preprocessing steps appear; the "None" operation has no Python steps', () => {
    const config = createInitialUniversalConfig(batch(['ring']))
    config.preprocessing = { operation: 'none', upscaleFactor: 2, trim: true, rotate: 90, resizeToHeight: 1000 }
    expect(stageIdsOfPhase(planItemStages('ring', config), 'preprocessing')).toEqual(['trim', 'rotate', 'resize'])
    config.preprocessing = { operation: 'background_removal', upscaleFactor: 4, trim: false, rotate: 0, resizeToHeight: null }
    expect(stageIdsOfPhase(planItemStages('ring', config), 'preprocessing')).toEqual(['background_removal'])
  })

  it('optional post-processing scripts appear only when enabled', () => {
    const config = createInitialUniversalConfig(batch(['ring']))
    expect(planItemStages('ring', config).some(s => s.id === 'pp:autoMCFF')).toBe(false)
    config.postProcessingByProduct.ring = { autoMCFF: true }
    expect(planItemStages('ring', config).at(-1)?.id).toBe('pp:autoMCFF')
  })

  it('Watch has AI Boundary Detection before processing; Gemstone edits by trimming to a `;compare` reference, then resizeGems', () => {
    const watch = planItemStages('watch', createInitialUniversalConfig(batch(['watch'])))
    expect(stageIdsOfPhase(watch, 'editing')).toEqual(['ai_detection', 'editing'])
    expect(watch.filter(s => s.phase === 'post_processing').map(s => s.id)).toEqual(['pp:removeShadows', 'pp:compressorNew'])

    const config = createInitialUniversalConfig(batch(['gemstone']))
    expect(config.preprocessing.trim).toBe(false)
    // Trim is now the Gemstone EDITING stage (it produces ;compare) — preprocessing config is passed through untouched.
    expect(preprocessingConfigFor('gemstone', config.preprocessing)).toEqual(config.preprocessing)
    const gem = planItemStages('gemstone', config)
    expect(gem.map(s => s.label)).toEqual(['Upscaling', 'Background Removal', 'Trim & Save Compare', 'resizeGems', 'compressorNew'])
  })
})

describe('item state transitions', () => {
  it('a running stage marks the item running with that stage; finishing it clears the current stage', () => {
    const i = item({ sku: 'A' })
    setItemStage(i, 'upscale', 'running', NOW)
    expect(i).toMatchObject({ status: 'running', stage: 'Upscaling', startedAt: NOW })
    setItemStage(i, 'upscale', 'done', NOW)
    expect(i.stage).toBeNull()
    expect(i.stages!.find(s => s.id === 'upscale')!.status).toBe('done')
  })

  it('unknown stage ids are ignored (a runner sub-stage the plan does not include)', () => {
    const i = item({ sku: 'A' })
    setItemStage(i, 'nonexistent', 'running', NOW)
    expect(i.status).toBe('queued')
  })

  it('failing an item marks the running stage failed and records the structured failure', () => {
    const i = item({ sku: 'A' })
    setItemStage(i, 'background_removal', 'running', NOW)
    failItem(i, makeAutomationError('BACKGROUND_REMOVAL_FAILED', { sku: 'A' }), NOW)
    expect(i.status).toBe('failed')
    expect(i.stages!.find(s => s.id === 'background_removal')!.status).toBe('failed')
    expect(i.failure?.code).toBe('BACKGROUND_REMOVAL_FAILED')
    expect(i.error).toContain('Background removal failed')
    expect(i.finishedAt).toBe(NOW)
  })

  it('terminal items are never relabelled: completed stays completed on cancel/fail; failed stays failed on cancel/complete', () => {
    const done = item({ sku: 'D' })
    completeItem(done, NOW)
    cancelItem(done, NOW)
    failItem(done, makeAutomationError('INTERNAL_ERROR'), NOW)
    expect(done.status).toBe('completed')

    const failed = item({ sku: 'F' })
    failItem(failed, makeAutomationError('INTERNAL_ERROR'), NOW)
    cancelItem(failed, NOW)
    completeItem(failed, NOW)
    expect(failed.status).toBe('failed')
  })

  it('cancelling skips only unfinished stages, keeping completed ones', () => {
    const i = item({ sku: 'A' })
    setItemStage(i, 'upscale', 'done', NOW)
    setItemStage(i, 'background_removal', 'running', NOW)
    cancelItem(i, NOW)
    expect(i.status).toBe('cancelled')
    expect(i.stages!.find(s => s.id === 'upscale')!.status).toBe('done')
    expect(i.stages!.find(s => s.id === 'background_removal')!.status).toBe('skipped')
  })
})

describe('JobProgressRecorder — buffered persistence', () => {
  function makeDetail(items: SandboxRunItemState[]): SandboxRunDetail {
    return { items, pipelines: [{ productType: 'ring', status: 'running', activity: null }] } as unknown as SandboxRunDetail
  }

  it('folds a burst of updates into ONE persisted write applying all of them in order', async () => {
    let detail = makeDetail([item({ sku: 'A' }), item({ sku: 'B' })])
    const persist = vi.fn(async (mutate: (d: SandboxRunDetail) => Partial<SandboxRunDetail>) => {
      detail = { ...detail, ...mutate(detail) }
    })
    const recorder = new JobProgressRecorder(persist, 10_000)
    recorder.stage('ring', 'A', 'upscale', 'running')
    recorder.stage('ring', 'A', 'upscale', 'done')
    recorder.stage('ring', 'B', 'upscale', 'running')
    recorder.activity('ring', 'Preprocessing')
    recorder.fail('ring', 'B', makeAutomationError('UPSCALE_FAILED', { sku: 'B' }), 'upscale')
    expect(persist).not.toHaveBeenCalled()
    await recorder.flush()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(detail.items[0].stages!.find(s => s.id === 'upscale')!.status).toBe('done')
    expect(detail.items[1]).toMatchObject({ status: 'failed', failure: { code: 'UPSCALE_FAILED' } })
    expect(detail.pipelines[0].activity).toBe('Preprocessing')
  })

  it('flushes on its own timer, and a flush with nothing pending writes nothing', async () => {
    vi.useFakeTimers()
    let calls = 0
    const recorder = new JobProgressRecorder(async () => { calls++ }, 50)
    recorder.stage('ring', 'A', 'upscale', 'running')
    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toBe(1)
    await recorder.flush()
    expect(calls).toBe(1)
    vi.useRealTimers()
  })

  it('only affects the named product', async () => {
    let detail = makeDetail([item({ sku: 'A' }), item({ sku: 'A', productType: 'bracelet' })])
    const recorder = new JobProgressRecorder(async m => { detail = { ...detail, ...m(detail) } }, 10_000)
    recorder.completeAllActive('ring')
    await recorder.flush()
    expect(detail.items.map(i => i.status)).toEqual(['completed', 'queued'])
  })
})

describe('summarizeImageProgress', () => {
  const T0 = Date.parse('2026-01-01T00:00:00.000Z')
  function run(items: Partial<SandboxRunItemState>[], overrides: Partial<SandboxRunDetail> = {}): SandboxRunDetail {
    return {
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      pipelines: [
        { productType: 'ring', status: 'running', activity: 'Editing' },
        { productType: 'bracelet', status: 'running', activity: null },
        { productType: 'necklace', status: 'unavailable', activity: null },
      ],
      items: items.map((i, n) => ({ sku: `S${n}`, productType: 'ring', status: 'queued', error: null, ...i })),
      ...overrides,
    } as unknown as SandboxRunDetail
  }
  const editingDone = [{ id: 'editing', label: 'Ring Editing', phase: 'editing', status: 'done' }] as any

  it('counts per run and per product concurrently, excluding unavailable items from the total', () => {
    const p = summarizeImageProgress(
      run([
        { status: 'completed' }, { status: 'running', stage: 'Upscaling' }, { status: 'queued' },
        { productType: 'bracelet', status: 'completed' }, { productType: 'bracelet', status: 'failed' },
        { productType: 'necklace', status: 'unavailable' },
      ]),
      T0 + 1000,
    )
    expect(p).toMatchObject({ totalImages: 5, completed: 2, failed: 1, running: 1, queued: 1, unavailable: 1 })
    expect(p.current).toEqual([{ productType: 'ring', sku: 'S1', stage: 'Upscaling' }])
    const ring = p.perProduct.find(x => x.productType === 'ring')!
    expect(ring).toMatchObject({ total: 3, completed: 1, running: 1, queued: 1, activity: 'Editing' })
    expect(p.perProduct.find(x => x.productType === 'bracelet')).toMatchObject({ total: 2, completed: 1, failed: 1 })
  })

  it('no rate or ETA is fabricated with too little data (fewer than 2 processed, or under 3s)', () => {
    const one = run([{ status: 'completed' }, { status: 'queued' }, { status: 'queued' }])
    expect(summarizeImageProgress(one, T0 + 60_000)).toMatchObject({ ratePerMinute: null, etaMs: null })
    const two = run([{ status: 'completed' }, { status: 'completed' }, { status: 'queued' }])
    expect(summarizeImageProgress(two, T0 + 1000)).toMatchObject({ ratePerMinute: null, etaMs: null })
  })

  it('rate and ETA appear once genuinely calculable, from images finished with per-image work', () => {
    const r = run([{ status: 'completed' }, { status: 'running', stages: editingDone }, { status: 'queued' }, { status: 'queued' }])
    const p = summarizeImageProgress(r, T0 + 60_000)
    expect(p.ratePerMinute).toBeCloseTo(2, 5) // 2 processed in 1 minute
    expect(p.etaMs).toBe(60_000) // 2 remaining at 2/min
  })

  it('no ETA once only batch post-processing remains, and none after the run has ended', () => {
    const allEdited = run([{ status: 'running', stages: editingDone }, { status: 'running', stages: editingDone }])
    expect(summarizeImageProgress(allEdited, T0 + 60_000).etaMs).toBeNull()
    const ended = run([{ status: 'completed' }, { status: 'completed' }, { status: 'queued' }], { status: 'failed', finishedAt: '2026-01-01T00:01:00.000Z' })
    expect(summarizeImageProgress(ended, T0 + 3_600_000)).toMatchObject({ ratePerMinute: null, etaMs: null })
  })
})
