// DEVELOPMENT/TESTING bridge — IPC boundary: the renderer only ever names a
// local test batch by id; sandbox:start-run re-resolves it from the Legacy
// registry in the main process and never trusts the renderer-supplied
// paths. Real registry + real adapter; only the orchestrator is captured.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir: string
let handlers: Record<string, (...a: any[]) => any> = {}
const startSandboxRunMock = vi.fn()
const retryImageMock = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => join(scratchDir, 'userData'), getAppPath: () => join(__dirname, '..', 'apps', 'desktop') },
  ipcMain: { handle: (channel: string, fn: (...a: any[]) => any) => { handlers[channel] = fn } },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../apps/desktop/electron/sandbox/sandboxOrchestrator', () => ({
  createJob: (...a: unknown[]) => startSandboxRunMock(...a),
  startJob: async () => ({ ok: true }),
  cancelSandboxRun: vi.fn(),
  recoverInterruptedJobs: async () => [],
  retryImage: (...args: unknown[]) => retryImageMock(...args),
}))

describe('local test batch IPC boundary', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-local-handlers-test-'))
    handlers = {}
    startSandboxRunMock.mockReset().mockResolvedValue({ ok: true, runId: 'r1' })
    vi.resetModules()
  })
  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('lists local batches via a thin channel and start-run substitutes the registry-resolved batch for whatever the renderer sent', async () => {
    const dir = join(scratchDir, 'src')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'R1.png'), 'x')
    const { createBatch, updateStage } = await import('../apps/desktop/electron/services/batchRegistry')
    const legacy = await createBatch({ sourceDir: dir, pipeline: ['editing'], title: 'Ring' })
    await updateStage(legacy.id, 'editing', { config: { product: 'ring' } })

    const { registerSandboxHandlers } = await import('../apps/desktop/electron/ipc/sandboxHandlers')
    registerSandboxHandlers()
    expect(Object.keys(handlers)).toContain('sandbox:list-local-test-batches')

    const list = await handlers['sandbox:list-local-test-batches']({})
    const id = list.batches[0].id

    const forged = { id, name: 'forged', productTypes: ['ring'], imageCount: 1, images: [{ sku: 'X', imagePath: '/etc/passwd', productType: 'ring' }] }
    await handlers['sandbox:start-run']({}, { batch: forged, config: { any: 'config' } })
    const passed = startSandboxRunMock.mock.calls[0][0]
    expect(passed.images).toEqual([{ sku: 'R1', imagePath: join(dir, 'R1.png'), productType: 'ring' }])
    expect(JSON.stringify(passed)).not.toContain('/etc/passwd')

    // A local id that resolves to nothing fails cleanly and starts nothing.
    startSandboxRunMock.mockClear()
    const bad = await handlers['sandbox:start-run']({}, { batch: { ...forged, id: 'local-legacy:nope' }, config: {} })
    expect(bad.ok).toBe(false)
    expect(startSandboxRunMock).not.toHaveBeenCalled()

    // A non-local batch is passed through exactly as before.
    const mock = { ...forged, id: 'mock-temp-batch-1' }
    await handlers['sandbox:start-run']({}, { batch: mock, config: {} })
    expect(startSandboxRunMock.mock.calls[0][0]).toBe(mock)

    // Detail channel resolves local ids and leaves other ids on the Sandbox API path.
    expect((await handlers['sandbox:get-temporary-batch-detail']({}, { id })).images[0].sku).toBe('R1')
    expect((await handlers['sandbox:get-temporary-batch-detail']({}, { id: 'mock-temp-batch-1' })).id).toBe('mock-temp-batch-1')
  })
})
