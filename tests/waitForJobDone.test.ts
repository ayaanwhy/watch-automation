// Phase 15.3 — waitForJobDone + mainProcessJobEvents: the real mechanism
// the Sandbox orchestrator uses to await a subprocess-backed job's
// completion in the main process without any renderer/IPC round trip.
// notifyAllWindows is exercised for real here (not reimplemented) — this
// proves the actual bridge subprocessRunner.ts now exposes, not a
// reimplementation of it.
import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}))

describe('waitForJobDone / mainProcessJobEvents (Phase 15.3)', () => {
  it('resolves with the payload for the matching jobId, ignoring other jobs on the same channel', async () => {
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { waitForJobDone } = await import('../apps/desktop/electron/sandbox/waitForJobDone')

    const waiter = waitForJobDone<{ jobId: string; succeeded: number }>('preprocess:done', 'job-b')

    // A different job's done event first — must not resolve the waiter.
    notifyAllWindows('preprocess:done', { jobId: 'job-a', succeeded: 1 })
    await new Promise(r => setTimeout(r, 10))

    notifyAllWindows('preprocess:done', { jobId: 'job-b', succeeded: 5 })
    const result = await waiter
    expect(result).toEqual({ jobId: 'job-b', succeeded: 5 })
  })

  it('two independent orchestrator-style callers each get their own job’s result, never the other’s', async () => {
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { waitForJobDone } = await import('../apps/desktop/electron/sandbox/waitForJobDone')

    const waiterA = waitForJobDone<{ jobId: string; product: string }>('ring-bracelet:done', 'job-ring')
    const waiterB = waitForJobDone<{ jobId: string; product: string }>('ring-bracelet:done', 'job-bracelet')

    notifyAllWindows('ring-bracelet:done', { jobId: 'job-bracelet', product: 'bracelet' })
    notifyAllWindows('ring-bracelet:done', { jobId: 'job-ring', product: 'ring' })

    const [resultA, resultB] = await Promise.all([waiterA, waiterB])
    expect(resultA.product).toBe('ring')
    expect(resultB.product).toBe('bracelet')
  })

  it('does not leak listeners — the listener is removed once the waiter resolves', async () => {
    const { notifyAllWindows, mainProcessJobEvents } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { waitForJobDone } = await import('../apps/desktop/electron/sandbox/waitForJobDone')

    const waiter = waitForJobDone('earring:done', 'job-once')
    expect(mainProcessJobEvents.listenerCount('earring:done')).toBe(1)

    notifyAllWindows('earring:done', { jobId: 'job-once' })
    await waiter

    expect(mainProcessJobEvents.listenerCount('earring:done')).toBe(0)
  })
})

describe('observeJobEvents — live per-image progress observation (automation engine)', () => {
  it('buffers events that arrive before the jobId is known, replays only the matching job\'s, then streams live', async () => {
    const { notifyAllWindows } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { observeJobEvents } = await import('../apps/desktop/electron/sandbox/waitForJobDone')

    const seen: string[] = []
    const observer = observeJobEvents('earring:event', e => seen.push(`${e['jobId']}:${e['type']}`))

    // A runner starts emitting before start() has returned its jobId.
    notifyAllWindows('earring:event', { jobId: 'mine', type: 'progress' })
    notifyAllWindows('earring:event', { jobId: 'other', type: 'progress' })
    expect(seen).toEqual([])

    observer.setJobId('mine')
    expect(seen).toEqual(['mine:progress']) // replayed, the other job's event dropped

    notifyAllWindows('earring:event', { jobId: 'mine', type: 'complete' })
    notifyAllWindows('earring:event', { jobId: 'other', type: 'complete' })
    expect(seen).toEqual(['mine:progress', 'mine:complete'])
  })

  it('stop() detaches the listener (no leak) and silences further events', async () => {
    const { notifyAllWindows, mainProcessJobEvents } = await import('../apps/desktop/electron/services/subprocessRunner')
    const { observeJobEvents } = await import('../apps/desktop/electron/sandbox/waitForJobDone')

    const before = mainProcessJobEvents.listenerCount('ring-bracelet:event')
    const seen: unknown[] = []
    const observer = observeJobEvents('ring-bracelet:event', e => seen.push(e))
    observer.setJobId('j')
    expect(mainProcessJobEvents.listenerCount('ring-bracelet:event')).toBe(before + 1)
    observer.stop()
    expect(mainProcessJobEvents.listenerCount('ring-bracelet:event')).toBe(before)
    notifyAllWindows('ring-bracelet:event', { jobId: 'j', type: 'progress' })
    expect(seen).toEqual([])
  })
})
