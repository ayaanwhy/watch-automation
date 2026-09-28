// Phase 15.3 — SandboxRun registry: creation/persistence, atomic writes,
// and recovery after a simulated reload (a fresh read of the same on-disk
// state, mirroring batchRegistryRecovery.test.ts's own approach for
// Legacy's registry).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
}))

describe('sandboxRunRegistry', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-run-registry-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('creates a run with queued pipelines for available products (incl. Gemstone) and an unavailable pipeline for Necklace', async () => {
    const { createSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const run = await createSandboxRun({
      title: 'Test Run',
      temporaryBatchId: 'batch-1',
      productTypes: ['watch', 'ring', 'necklace', 'gemstone'],
      universalConfig: { some: 'config' },
    })

    expect(run.status).toBe('draft')
    expect(run.items).toEqual([])
    expect(run.cancelRequested).toBe(false)

    const byProduct = Object.fromEntries(run.pipelines.map(p => [p.productType, p]))
    expect(byProduct.watch.status).toBe('queued')
    expect(byProduct.ring.status).toBe('queued')
    expect(byProduct.necklace.status).toBe('unavailable')
    expect(byProduct.necklace.error).toBeTruthy()
    expect(byProduct.gemstone.status).toBe('queued')
  })

  it('persists atomically and is readable back exactly as written', async () => {
    const { createSandboxRun, getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const created = await createSandboxRun({
      title: 'Persisted Run',
      temporaryBatchId: 'batch-2',
      productTypes: ['ring'],
      universalConfig: {},
    })
    const reread = await getSandboxRun(created.id)
    expect(reread).toEqual(created)
  })

  it('updateSandboxRun applies a partial patch and bumps updatedAt', async () => {
    const { createSandboxRun, updateSandboxRun, getSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const created = await createSandboxRun({ title: 'R', temporaryBatchId: 'b', productTypes: ['ring'], universalConfig: {} })
    const updated = await updateSandboxRun(created.id, { status: 'running' })
    expect(updated?.status).toBe('running')
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt))

    const reread = await getSandboxRun(created.id)
    expect(reread?.status).toBe('running')
  })

  it('updateSandboxRun on an unknown id returns null without creating anything', async () => {
    const { updateSandboxRun, listSandboxRuns } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const result = await updateSandboxRun('not-a-real-run', { status: 'running' })
    expect(result).toBeNull()
    expect(await listSandboxRuns()).toEqual([])
  })

  it('interrupted/reloaded run recovery: a fresh import (simulating an app restart) still lists and reads the same run', async () => {
    const { createSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const created = await createSandboxRun({ title: 'Recoverable', temporaryBatchId: 'b', productTypes: ['ring'], universalConfig: {} })

    // Simulate a process restart: reset the module registry and re-import
    // — nothing survives in memory, only what's on disk.
    vi.resetModules()
    const reimported = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const runs = await reimported.listSandboxRuns()
    expect(runs.some(r => r.id === created.id)).toBe(true)

    const detail = await reimported.getSandboxRun(created.id)
    expect(detail?.title).toBe('Recoverable')
    expect(detail?.pipelines[0]?.productType).toBe('ring')
  })

  it('rebuilds the index from detail files if index.json is missing', async () => {
    const { createSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const created = await createSandboxRun({ title: 'A', temporaryBatchId: 'b', productTypes: ['ring'], universalConfig: {} })

    const dir = join(scratchDir, 'sandbox-runs')
    await rm(join(dir, 'index.json'))
    // The detail file survives independently of the index — same guarantee
    // batchRegistry.ts's own rebuild-from-details fallback provides.
    const files = await readdir(dir)
    expect(files).toContain(`${created.id}.json`)

    vi.resetModules()
    const reimported = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    const runs = await reimported.listSandboxRuns()
    expect(runs.length).toBe(1)
    expect(runs[0].title).toBe('A')
  })
})
