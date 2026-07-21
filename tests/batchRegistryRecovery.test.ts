// Phase 11E — startup reconciliation, index rebuild, and corruption
// quarantine. batchRegistry.ts imports { app } from 'electron' purely for
// app.getPath('userData'); mocked here to a scratch temp directory so the
// module can be exercised outside a real Electron process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BatchSummaryRecord } from '../apps/desktop/src/types/batch.js'

let scratchDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => scratchDir,
  },
}))

describe('batchRegistry recovery (Phase 11E)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-batch-registry-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('marks a stage stuck at running as failed on startup (crash recovery)', async () => {
    const { createBatch, updateStage, getBatch, reconcileBatchesOnStartup } = await import('../apps/desktop/electron/services/batchRegistry.js')

    const batch = await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'] })
    await updateStage(batch.id, 'preprocessing', { status: 'running', outputDir: '/out' })

    // Simulate the app being killed mid-run: nothing more happens to the
    // detail file — it's left with status: 'running' on disk, exactly as a
    // crash or force-quit would leave it.
    const midCrash = await getBatch(batch.id)
    expect(midCrash?.stages[0].status).toBe('running')

    await reconcileBatchesOnStartup()

    const reconciled = await getBatch(batch.id)
    expect(reconciled?.stages[0].status).toBe('failed')
    expect(reconciled?.stages[0].error).toMatch(/interrupted/i)
  })

  it('leaves non-running batches untouched', async () => {
    const { createBatch, updateStage, getBatch, reconcileBatchesOnStartup } = await import('../apps/desktop/electron/services/batchRegistry.js')

    const batch = await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'] })
    await updateStage(batch.id, 'preprocessing', { status: 'completed', outputDir: '/out' })

    await reconcileBatchesOnStartup()

    const after = await getBatch(batch.id)
    expect(after?.stages[0].status).toBe('completed')
  })

  it('rebuilds the index from detail files when index.json is corrupt', async () => {
    const { createBatch, listBatches } = await import('../apps/desktop/electron/services/batchRegistry.js')

    const batch = await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'] })

    // Corrupt the index directly on disk — simulates a crash mid-write to
    // index.json (or any other corruption) while the detail file (source of
    // truth) remains intact.
    await writeFile(join(scratchDir, 'batches', 'index.json'), '{not valid json', 'utf-8')

    const batches: BatchSummaryRecord[] = await listBatches()
    expect(batches.map((b) => b.id)).toEqual([batch.id])
  })

  it('quarantines an unreadable detail file during startup reconciliation instead of leaving it stuck', async () => {
    const { createBatch, reconcileBatchesOnStartup, getBatch, listBatches } =
      await import('../apps/desktop/electron/services/batchRegistry.js')

    const good = await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'] })
    const batchesDir = join(scratchDir, 'batches')
    const corruptId = 'batch-corrupt-test'
    await writeFile(join(batchesDir, `${corruptId}.json`), '{not valid json at all', 'utf-8')

    await reconcileBatchesOnStartup()

    // The corrupt file is gone from its original location...
    const corruptStillThere = await getBatch(corruptId)
    expect(corruptStillThere).toBeNull()

    // ...moved into quarantine/ rather than deleted...
    const quarantined = await readdir(join(batchesDir, 'quarantine'))
    expect(quarantined.some((f) => f.startsWith(corruptId))).toBe(true)

    // ...and the good batch is unaffected.
    const batches: BatchSummaryRecord[] = await listBatches()
    expect(batches.map((b) => b.id)).toEqual([good.id])
  })

  it('rebuilds nextSeq/nextTestSeq correctly from surviving detail files', async () => {
    const { createBatch, reconcileBatchesOnStartup, listBatches } = await import('../apps/desktop/electron/services/batchRegistry.js')

    await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'], mode: 'production' })
    await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'], mode: 'production' })
    const third = await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'], mode: 'testing' })

    await reconcileBatchesOnStartup()

    const nextBatch = await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'], mode: 'production' })
    expect(nextBatch.seq).toBe(3)
    const nextTestBatch = await createBatch({ sourceDir: '/src', pipeline: ['preprocessing'], mode: 'testing' })
    expect(nextTestBatch.seq).toBe(third.seq + 1)

    const batches = await listBatches()
    expect(batches).toHaveLength(5)
  })

  it('handles a missing batches directory gracefully (fresh install)', async () => {
    const { reconcileBatchesOnStartup, listBatches } = await import('../apps/desktop/electron/services/batchRegistry.js')
    // No batches/ dir exists at all yet in scratchDir.
    await expect(reconcileBatchesOnStartup()).resolves.not.toThrow()
    expect(await listBatches()).toEqual([])
  })
})
