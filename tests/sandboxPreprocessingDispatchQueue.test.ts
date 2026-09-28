// Phase 15.3 — proves the Preprocessing dispatch-ordering queue
// (sandboxOrchestrator.ts's preprocessingDispatchQueue) genuinely
// serializes two products' calls to the shared Preprocessing runner,
// rather than letting the second one race the first. Real SingleFlightQueue,
// real mainProcessJobEvents/waitForJobDone, and the real
// runSandboxPreprocessingForProduct orchestration logic are exercised —
// only ProcessingBackend itself (the seam to the real Python subprocess) is
// substituted with a controllable fake, since what's under test here is the
// dispatch/serialization logic, not Python execution (already covered
// elsewhere — subprocessRunnerIncrementalPersistence.test.ts etc).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}))

const startMock = vi.fn()
vi.mock('../apps/desktop/electron/sandbox/processingBackend', () => ({
  localProcessingBackend: {
    preprocessing: {
      start: (...args: unknown[]) => startMock(...args),
      cancel: async () => ({ ok: true }),
    },
  },
}))

describe('Sandbox preprocessing dispatch queue (Phase 15.3)', () => {
  beforeEach(() => {
    startMock.mockReset()
  })

  it('never has two start() calls in flight at once when two products share one dispatch queue', async () => {
    const { SingleFlightQueue } = await import('../apps/desktop/electron/services/singleFlightQueue')
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { runSandboxPreprocessingForProduct } = await import('../apps/desktop/electron/sandbox/sandboxPreprocessingPipeline')

    let active = 0
    let maxActive = 0
    let jobCounter = 0
    const order: string[] = []

    startMock.mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      const jobId = `job-${++jobCounter}`
      order.push(`start:${jobId}`)
      setTimeout(() => {
        active--
        order.push(`done:${jobId}`)
        notifyAllWindows('preprocess:done', {
          jobId,
          exitCode: 0,
          succeeded: 1,
          failed: 0,
          totalDurationMs: 5,
          cancelledByUser: false,
        })
      }, 30)
      return { ok: true, jobId }
    })

    const queue = new SingleFlightQueue()
    const config = { operation: 'both' as const, upscaleFactor: 2 as const, trim: false, rotate: 0 as const, resizeToHeight: null }

    const [resultA, resultB] = await Promise.all([
      runSandboxPreprocessingForProduct({
        runId: 'run-1',
        productType: 'ring',
        batchId: 'batch-ring',
        config,
        preprocessingDispatchQueue: queue,
      }),
      runSandboxPreprocessingForProduct({
        runId: 'run-1',
        productType: 'earring',
        batchId: 'batch-earring',
        config,
        preprocessingDispatchQueue: queue,
      }),
    ])

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)
    expect(startMock).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)
    // Strict FIFO: the first job's done event lands before the second
    // job's start — never interleaved.
    expect(order).toEqual(['start:job-1', 'done:job-1', 'start:job-2', 'done:job-2'])
  })

  it('a rejected start() for one product does not block the next product’s dispatch', async () => {
    const { SingleFlightQueue } = await import('../apps/desktop/electron/services/singleFlightQueue')
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { runSandboxPreprocessingForProduct } = await import('../apps/desktop/electron/sandbox/sandboxPreprocessingPipeline')

    startMock
      .mockImplementationOnce(async () => ({ ok: false, error: 'A preprocessing job is already running' }))
      .mockImplementationOnce(async () => {
        const jobId = 'job-2'
        setTimeout(() => {
          notifyAllWindows('preprocess:done', { jobId, exitCode: 0, succeeded: 1, failed: 0, totalDurationMs: 5, cancelledByUser: false })
        }, 10)
        return { ok: true, jobId }
      })

    const queue = new SingleFlightQueue()
    const config = { operation: 'both' as const, upscaleFactor: 2 as const, trim: false, rotate: 0 as const, resizeToHeight: null }

    const resultA = await runSandboxPreprocessingForProduct({
      runId: 'run-1',
      productType: 'ring',
      batchId: 'batch-ring',
      config,
      preprocessingDispatchQueue: queue,
    })
    const resultB = await runSandboxPreprocessingForProduct({
      runId: 'run-1',
      productType: 'earring',
      batchId: 'batch-earring',
      config,
      preprocessingDispatchQueue: queue,
    })

    expect(resultA.ok).toBe(false)
    expect(resultB.ok).toBe(true)
  })

  // The Operation choice — never the factor — decides whether upscaling
  // runs: a stale/selected factor must be inert when Upscaling is off.
  it.each([
    ['background_removal', 4, ['background_removal'], 1],
    ['both', 4, ['background_removal', 'upscale'], 4],
    ['upscale', 2, ['upscale'], 2],
  ] as const)('operation %s with factor %d starts the runner with operations %j and scaleFactor %d', async (operation, upscaleFactor, expectedOps, expectedScale) => {
    const { SingleFlightQueue } = await import('../apps/desktop/electron/services/singleFlightQueue')
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { runSandboxPreprocessingForProduct } = await import('../apps/desktop/electron/sandbox/sandboxPreprocessingPipeline')

    startMock.mockImplementationOnce(async () => {
      setTimeout(() => notifyAllWindows('preprocess:done', { jobId: 'j', exitCode: 0, succeeded: 1, failed: 0, totalDurationMs: 1, cancelledByUser: false }), 5)
      return { ok: true, jobId: 'j' }
    })
    await runSandboxPreprocessingForProduct({
      runId: 'run-ops',
      productType: 'ring',
      batchId: 'b',
      config: { operation, upscaleFactor, trim: false, rotate: 0, resizeToHeight: null },
      preprocessingDispatchQueue: new SingleFlightQueue(),
    })
    const call = startMock.mock.calls[0][0]
    expect(call.operations).toEqual(expectedOps)
    expect(call.scaleFactor).toBe(expectedScale)
  })
})
