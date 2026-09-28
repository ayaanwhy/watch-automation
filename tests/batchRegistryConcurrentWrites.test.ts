// Phase 15.5 — regression test for a real bug this phase's own Sandbox
// orchestrator tests surfaced: batchRegistry.ts's createBatch/updateStage/
// renameBatch/setBatchMode/deleteBatch each did an unserialized
// read-modify-write against the shared index.json. Legacy's own UI never
// triggered two concurrent writers, but Sandbox's orchestrator (Phase
// 15.3+) legitimately calls createBatch from multiple product pipelines
// running in parallel — two landing at the same instant raced two
// concurrent index.json.tmp renames, and the loser threw ENOENT. Fixed by
// serializing every write (mirrors sandboxRunRegistry.ts's identical fix).
// This proves the fix without needing Sandbox at all — plain concurrent
// calls into the real, unmodified Legacy registry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
}))

describe('batchRegistry — concurrent writes (Phase 15.5 regression)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-batch-registry-concurrency-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('ten concurrent createBatch calls all persist — none lost to a racing index.json write', async () => {
    const { createBatch, listBatches } = await import('../apps/desktop/electron/services/batchRegistry')

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createBatch({ sourceDir: `/source-${i}`, pipeline: ['preprocessing'], title: `Batch ${i}` }),
      ),
    )
    expect(created).toHaveLength(10)
    expect(new Set(created.map(b => b.id)).size).toBe(10) // every id genuinely distinct

    const listed = await listBatches()
    expect(listed).toHaveLength(10)
    for (const batch of created) {
      expect(listed.some(b => b.id === batch.id)).toBe(true)
    }
  })

  it('concurrent updateStage calls against different batches all land, none silently dropped', async () => {
    const { createBatch, updateStage, getBatch } = await import('../apps/desktop/electron/services/batchRegistry')

    const batches = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createBatch({ sourceDir: `/s-${i}`, pipeline: ['preprocessing'] })),
    )

    await Promise.all(
      batches.map(b => updateStage(b.id, 'preprocessing', { status: 'running', outputDir: `/out-${b.id}` })),
    )

    for (const batch of batches) {
      const detail = await getBatch(batch.id)
      const stage = detail!.stages.find(s => s.type === 'preprocessing')!
      expect(stage.status).toBe('running')
      expect(stage.outputDir).toBe(`/out-${batch.id}`)
    }
  })

  it('sequential behavior is completely unchanged — same values, same seq assignment', async () => {
    const { createBatch } = await import('../apps/desktop/electron/services/batchRegistry')

    const a = await createBatch({ sourceDir: '/a', pipeline: ['preprocessing'], title: 'A' })
    const b = await createBatch({ sourceDir: '/b', pipeline: ['preprocessing'], title: 'B' })

    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.title).toBe('A')
    expect(b.title).toBe('B')
  })
})
