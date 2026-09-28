// Phase 15.3 — the renderer/main IPC contract for Sandbox execution:
// proves registerSandboxHandlers wires the exact channel names the
// renderer (SandboxWorkflowContext.tsx) actually calls to the real
// orchestrator/registry functions, using a fake ipcMain that captures each
// registered handler so this exercises real delegation, not just "was a
// function called."
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir: string
const startSandboxRunMock = vi.fn()
const retryImageMock = vi.fn()
const cancelSandboxRunMock = vi.fn()
const getSandboxReviewItemsMock = vi.fn()
const approveSandboxItemsMock = vi.fn()
const rejectSandboxItemsMock = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir, getAppPath: () => tmpdir() },
  ipcMain: { handle: (...args: unknown[]) => registeredHandlers.push(args as [string, (...a: unknown[]) => unknown]) },
  BrowserWindow: { getAllWindows: () => [] },
}))

// The handlers are an Electron transport adapter over the Automation Engine
// facade, which wraps the orchestrator's job lifecycle — so the orchestrator
// (job execution) is what's substituted here; the facade and handlers are real.
vi.mock('../apps/desktop/electron/sandbox/sandboxOrchestrator', () => ({
  createJob: (...args: unknown[]) => startSandboxRunMock(...args),
  startJob: async () => ({ ok: true }),
  cancelSandboxRun: (...args: unknown[]) => cancelSandboxRunMock(...args),
  recoverInterruptedJobs: async () => [],
  retryImage: (...args: unknown[]) => retryImageMock(...args),
}))

// Phase 15.6 — sandboxReviewService.ts is exercised on its own (see
// sandboxReviewService.test.ts); here we only need to prove the IPC layer
// delegates to it correctly, exactly like the orchestrator mock above.
vi.mock('../apps/desktop/electron/sandbox/sandboxReviewService', () => ({
  getSandboxReviewItems: (...args: unknown[]) => getSandboxReviewItemsMock(...args),
  approveSandboxItems: (...args: unknown[]) => approveSandboxItemsMock(...args),
  rejectSandboxItems: (...args: unknown[]) => rejectSandboxItemsMock(...args),
}))

let registeredHandlers: [string, (...args: unknown[]) => unknown][] = []

describe('sandboxHandlers IPC contract (Phase 15.3)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-handlers-ipc-test-'))
    registeredHandlers = []
    startSandboxRunMock.mockReset()
    cancelSandboxRunMock.mockReset()
    getSandboxReviewItemsMock.mockReset()
    approveSandboxItemsMock.mockReset()
    rejectSandboxItemsMock.mockReset()
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('registers exactly the channels the renderer calls, each delegating to the real underlying function', async () => {
    const { registerSandboxHandlers } = await import('../apps/desktop/electron/ipc/sandboxHandlers')
    registerSandboxHandlers()

    const channels = registeredHandlers.map(([channel]) => channel)
    expect(channels).toEqual(
      expect.arrayContaining([
        'sandbox:list-temporary-batches',
        'sandbox:get-temporary-batch-detail',
        'sandbox:start-run',
        'sandbox:cancel-run',
        'sandbox:get-run',
        'sandbox:list-runs',
        'sandbox:retry-image',
      ]),
    )

    const startHandler = registeredHandlers.find(([c]) => c === 'sandbox:start-run')![1]
    startSandboxRunMock.mockResolvedValue({ ok: true, runId: 'run-123' })
    const startResult = await startHandler({}, { batch: { id: 'b1' }, config: { some: 'config' } })
    expect(startSandboxRunMock).toHaveBeenCalledWith({ id: 'b1' }, { some: 'config' })
    expect(startResult).toEqual({ ok: true, runId: 'run-123' })

    const cancelHandler = registeredHandlers.find(([c]) => c === 'sandbox:cancel-run')![1]
    cancelSandboxRunMock.mockResolvedValue({ ok: true })
    const cancelResult = await cancelHandler({}, { id: 'run-123' })
    expect(cancelSandboxRunMock).toHaveBeenCalledWith('run-123')
    expect(cancelResult).toEqual({ ok: true })

    // Retry Image is a thin transport over the engine's retryImage.
    const retryHandler = registeredHandlers.find(([c]) => c === 'sandbox:retry-image')![1]
    retryImageMock.mockResolvedValue({ ok: true })
    expect(await retryHandler({}, { runId: 'run-123', productType: 'watch', sku: 'W-1' })).toEqual({ ok: true })
    expect(retryImageMock).toHaveBeenCalledWith('run-123', 'watch', 'W-1')
  })

  it('sandbox:get-run and sandbox:list-runs read through to the real registry (not the mocked orchestrator)', async () => {
    const { registerSandboxHandlers } = await import('../apps/desktop/electron/ipc/sandboxHandlers')
    const { createSandboxRun } = await import('../apps/desktop/electron/sandbox/sandboxRunRegistry')
    registerSandboxHandlers()

    const created = await createSandboxRun({ title: 'IPC Test Run', temporaryBatchId: 'b1', productTypes: ['ring'], universalConfig: {} })

    const getRunHandler = registeredHandlers.find(([c]) => c === 'sandbox:get-run')![1]
    const fetched = await getRunHandler({}, { id: created.id })
    expect(fetched).toEqual(created)

    const listRunsHandler = registeredHandlers.find(([c]) => c === 'sandbox:list-runs')![1]
    const list = await listRunsHandler({})
    expect((list as { id: string }[]).some(r => r.id === created.id)).toBe(true)
  })

  it('Phase 15.6 — registers the Final Review channels, each delegating to sandboxReviewService (never talking to the batch registry/Sandbox API directly)', async () => {
    const { registerSandboxHandlers } = await import('../apps/desktop/electron/ipc/sandboxHandlers')
    registerSandboxHandlers()

    const channels = registeredHandlers.map(([channel]) => channel)
    expect(channels).toEqual(
      expect.arrayContaining(['sandbox:get-review-items', 'sandbox:list-editors', 'sandbox:approve-items', 'sandbox:reject-items']),
    )

    getSandboxReviewItemsMock.mockResolvedValue([{ sku: 'RING-1' }])
    const getReviewItemsHandler = registeredHandlers.find(([c]) => c === 'sandbox:get-review-items')![1]
    const items = await getReviewItemsHandler({}, { id: 'run-1' })
    expect(getSandboxReviewItemsMock).toHaveBeenCalledWith('run-1')
    expect(items).toEqual([{ sku: 'RING-1' }])

    const listEditorsHandler = registeredHandlers.find(([c]) => c === 'sandbox:list-editors')![1]
    const editors = await listEditorsHandler({})
    expect(editors).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.any(String), name: expect.any(String) })]))

    approveSandboxItemsMock.mockResolvedValue({ ok: true, results: { 'ring:RING-1': { ok: true } } })
    const approveHandler = registeredHandlers.find(([c]) => c === 'sandbox:approve-items')![1]
    const approveResult = await approveHandler({}, { runId: 'run-1', keys: [{ productType: 'ring', sku: 'RING-1' }] })
    expect(approveSandboxItemsMock).toHaveBeenCalledWith('run-1', [{ productType: 'ring', sku: 'RING-1' }])
    expect(approveResult).toEqual({ ok: true, results: { 'ring:RING-1': { ok: true } } })

    rejectSandboxItemsMock.mockResolvedValue({ ok: true, results: { 'ring:RING-1': { ok: true } } })
    const rejectHandler = registeredHandlers.find(([c]) => c === 'sandbox:reject-items')![1]
    const rejectResult = await rejectHandler(
      {},
      { runId: 'run-1', keys: [{ productType: 'ring', sku: 'RING-1' }], reason: 'bad crop', instructions: null, editor: { id: 'e1', name: 'Editor One' } },
    )
    expect(rejectSandboxItemsMock).toHaveBeenCalledWith('run-1', {
      keys: [{ productType: 'ring', sku: 'RING-1' }],
      reason: 'bad crop',
      instructions: null,
      editor: { id: 'e1', name: 'Editor One' },
    })
    expect(rejectResult).toEqual({ ok: true, results: { 'ring:RING-1': { ok: true } } })
  })
})
