// Phase 11.5E — Manual QA review: setImageNeedsFixing toggles the flag,
// recomputes counts, persists, and survives a simulated app restart.
// electron mocked to a scratch dir, same pattern as batchRegistryRecovery.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StageImageRecord } from '../apps/desktop/src/types/batch.js'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
}))

const COMPLETED_IMAGES: StageImageRecord[] = [
  { name: 'a.png', status: 'completed', outputPath: '/out/a.png', error: null, durationMs: 100 },
  { name: 'b.png', status: 'completed', outputPath: '/out/b.png', error: null, durationMs: 100 },
  { name: 'c.png', status: 'failed', outputPath: null, error: 'boom', durationMs: null },
]

describe('setImageNeedsFixing (Phase 11.5E)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-needs-fixing-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('flags a completed image and excludes it from succeeded, adding it to needsFixing', async () => {
    const { createBatch, updateStage, setImageNeedsFixing, getBatch } = await import(
      '../apps/desktop/electron/services/batchRegistry.js'
    )
    const batch = await createBatch({ sourceDir: '/src', pipeline: ['editing'] })
    await updateStage(batch.id, 'editing', {
      status: 'completed',
      images: COMPLETED_IMAGES,
      counts: { total: 3, succeeded: 2, failed: 1, cancelled: 0, needsFixing: 0, lowConfidence: 0 },
    })

    const updated = await setImageNeedsFixing(batch.id, 'editing', 'a.png', true)
    const stage = updated?.stages.find(s => s.type === 'editing')

    expect(stage?.images.find(i => i.name === 'a.png')?.needsFixing).toBe(true)
    // status is untouched — the image is still 'completed', just excluded
    // from the succeeded count.
    expect(stage?.images.find(i => i.name === 'a.png')?.status).toBe('completed')
    expect(stage?.counts).toEqual({ total: 3, succeeded: 1, failed: 1, cancelled: 0, needsFixing: 1, lowConfidence: 0 })

    // Non-destructive — the other images and the total are untouched.
    expect(stage?.images).toHaveLength(3)
    expect(stage?.images.find(i => i.name === 'b.png')?.needsFixing).toBeUndefined()
  })

  it('unflags an image, restoring it to succeeded', async () => {
    const { createBatch, updateStage, setImageNeedsFixing } = await import(
      '../apps/desktop/electron/services/batchRegistry.js'
    )
    const batch = await createBatch({ sourceDir: '/src', pipeline: ['editing'] })
    await updateStage(batch.id, 'editing', {
      status: 'completed',
      images: COMPLETED_IMAGES,
      counts: { total: 3, succeeded: 2, failed: 1, cancelled: 0, needsFixing: 0, lowConfidence: 0 },
    })

    await setImageNeedsFixing(batch.id, 'editing', 'a.png', true)
    const restored = await setImageNeedsFixing(batch.id, 'editing', 'a.png', false)
    const stage = restored?.stages.find(s => s.type === 'editing')

    expect(stage?.images.find(i => i.name === 'a.png')?.needsFixing).toBe(false)
    expect(stage?.counts).toEqual({ total: 3, succeeded: 2, failed: 1, cancelled: 0, needsFixing: 0, lowConfidence: 0 })
  })

  it('refuses to flag a non-completed image (nothing to review)', async () => {
    const { createBatch, updateStage, setImageNeedsFixing } = await import(
      '../apps/desktop/electron/services/batchRegistry.js'
    )
    const batch = await createBatch({ sourceDir: '/src', pipeline: ['editing'] })
    await updateStage(batch.id, 'editing', {
      status: 'completed',
      images: COMPLETED_IMAGES,
      counts: { total: 3, succeeded: 2, failed: 1, cancelled: 0, needsFixing: 0, lowConfidence: 0 },
    })

    const result = await setImageNeedsFixing(batch.id, 'editing', 'c.png', true)
    expect(result).toBeNull()
  })

  it('returns null for an unknown image or batch', async () => {
    const { createBatch, updateStage, setImageNeedsFixing } = await import(
      '../apps/desktop/electron/services/batchRegistry.js'
    )
    const batch = await createBatch({ sourceDir: '/src', pipeline: ['editing'] })
    await updateStage(batch.id, 'editing', {
      status: 'completed',
      images: COMPLETED_IMAGES,
      counts: { total: 3, succeeded: 2, failed: 1, cancelled: 0, needsFixing: 0, lowConfidence: 0 },
    })

    expect(await setImageNeedsFixing(batch.id, 'editing', 'does-not-exist.png', true)).toBeNull()
    expect(await setImageNeedsFixing('does-not-exist-batch', 'editing', 'a.png', true)).toBeNull()
  })

  it('survives a simulated app restart (persisted to disk, reloaded fresh)', async () => {
    const first = await import('../apps/desktop/electron/services/batchRegistry.js')
    const batch = await first.createBatch({ sourceDir: '/src', pipeline: ['editing'] })
    await first.updateStage(batch.id, 'editing', {
      status: 'completed',
      images: COMPLETED_IMAGES,
      counts: { total: 3, succeeded: 2, failed: 1, cancelled: 0, needsFixing: 0, lowConfidence: 0 },
    })
    await first.setImageNeedsFixing(batch.id, 'editing', 'b.png', true)

    vi.resetModules()
    const second = await import('../apps/desktop/electron/services/batchRegistry.js')
    const reloaded = await second.getBatch(batch.id)
    const stage = reloaded?.stages.find(s => s.type === 'editing')

    expect(stage?.images.find(i => i.name === 'b.png')?.needsFixing).toBe(true)
    expect(stage?.counts.needsFixing).toBe(1)
    expect(stage?.counts.succeeded).toBe(1)
  })
})
