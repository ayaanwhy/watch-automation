import { describe, it, expect } from 'vitest'
import { SingleFlightQueue } from '../apps/desktop/electron/services/singleFlightQueue'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

// Phase 15.0 — the main-process counterpart to AnnotationContext.tsx's
// renderer-side SingleFlightQueue<K>, but unkeyed (no per-key caching — see
// this file's own doc comment for why the shapes genuinely differ) and
// used to serialize every boundary:detect call app-wide, not just within
// one React component.
describe('SingleFlightQueue (main-process, unkeyed)', () => {
  it('never runs two jobs concurrently — the second enqueued job waits for the first to finish', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const order: string[] = []
    const queue = new SingleFlightQueue()

    const runJob = (label: string, delayMs: number) =>
      queue.run(async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        order.push(`start:${label}`)
        await new Promise(r => setTimeout(r, delayMs))
        order.push(`end:${label}`)
        concurrent--
        return label
      })

    const [a, b] = await Promise.all([runJob('A', 20), runJob('B', 5)])

    expect(maxConcurrent).toBe(1)
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
    expect(a).toBe('A')
    expect(b).toBe('B')
  })

  it('propagates each job\'s own resolved value back to its own caller, not a mixed-up one', async () => {
    const queue = new SingleFlightQueue()
    const results = await Promise.all([
      queue.run(async () => 1),
      queue.run(async () => 'two'),
      queue.run(async () => ({ three: 3 })),
    ])
    expect(results).toEqual([1, 'two', { three: 3 }])
  })

  it('propagates a rejected job to its own caller without blocking subsequent jobs', async () => {
    const queue = new SingleFlightQueue()
    const order: string[] = []

    const failing = queue.run(async () => {
      order.push('fail')
      throw new Error('boom')
    })
    const succeeding = queue.run(async () => {
      order.push('succeed')
      return 'ok'
    })

    await expect(failing).rejects.toThrow('boom')
    await expect(succeeding).resolves.toBe('ok')
    expect(order).toEqual(['fail', 'succeed'])
  })

  it('three independent callers enqueued at once still run strictly one at a time, in arrival order', async () => {
    const queue = new SingleFlightQueue()
    let concurrent = 0
    let maxConcurrent = 0
    const started: string[] = []

    function job(label: string) {
      return queue.run(async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        started.push(label)
        await new Promise(r => setTimeout(r, 10))
        concurrent--
        return label
      })
    }

    await Promise.all([job('first'), job('second'), job('third')])
    expect(maxConcurrent).toBe(1)
    expect(started).toEqual(['first', 'second', 'third'])
  })

  it('a job enqueued while the queue is idle runs immediately (no artificial delay)', async () => {
    const queue = new SingleFlightQueue()
    const gate = deferred<void>()
    let ran = false
    const p = queue.run(async () => {
      ran = true
      await gate.promise
    })
    await new Promise(r => setTimeout(r, 5))
    expect(ran).toBe(true)
    gate.resolve()
    await p
  })
})
