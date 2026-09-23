import { describe, it, expect, vi } from 'vitest'
import { SingleFlightQueue } from '../apps/desktop/src/context/AnnotationContext'

// Phase 14C — closes the residual gap identified after the same-day
// prefetch/trigger sequencing fix: isPrefetchEligible alone doesn't cover
// every caller (a forced manual Retry, or jumping to an arbitrary SKU,
// could still start a second concurrent request). AnnotationContext now
// routes every detection request (trigger, prefetch, retry) through one
// SingleFlightQueue instance instead. These tests exercise the queue
// directly with a fake, controllable-delay runner — no network, no React
// rendering — verifying the actual absolute-serialization property, not
// just the eligibility heuristic.

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('SingleFlightQueue', () => {
  it('never runs two jobs concurrently — a second enqueue while one is in flight waits for it to finish', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const order: string[] = []

    const queue = new SingleFlightQueue<string>(
      async (key) => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        order.push(`start:${key}`)
        await new Promise(r => setTimeout(r, 20))
        order.push(`end:${key}`)
        concurrent--
      },
      () => false,
    )

    queue.enqueue('A')
    queue.enqueue('B') // enqueued while A is (about to be) in flight

    await new Promise(r => setTimeout(r, 100))

    expect(maxConcurrent).toBe(1)
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
  })

  it('a forced retry for a key that already has a result still waits its turn behind whatever is currently in flight (the exact gap this closes)', async () => {
    const order: string[] = []
    let concurrent = 0
    let maxConcurrent = 0
    const aGate = deferred<void>()

    const queue = new SingleFlightQueue<string>(
      async (key) => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        order.push(`start:${key}`)
        if (key === 'A') await aGate.promise // hold A in flight until the test releases it
        order.push(`end:${key}`)
        concurrent--
      },
      key => key === 'B', // B already has a cached result
    )

    queue.enqueue('A') // e.g. a prefetch for the next SKU, still in flight
    await new Promise(r => setTimeout(r, 5)) // let A actually start

    queue.enqueue('B', true) // e.g. Retry, forced despite already having a result

    // While A is still held in flight, B must not have started yet.
    expect(order).toEqual(['start:A'])
    expect(maxConcurrent).toBe(1)

    aGate.resolve()
    await new Promise(r => setTimeout(r, 30))

    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
    expect(maxConcurrent).toBe(1)
  })

  it('skips a non-forced enqueue for a key that already has a result', async () => {
    const runner = vi.fn(async () => {})
    const queue = new SingleFlightQueue<string>(runner, () => true)
    queue.enqueue('A')
    await new Promise(r => setTimeout(r, 10))
    expect(runner).not.toHaveBeenCalled()
  })

  it('a forced enqueue runs even when a result already exists', async () => {
    const runner = vi.fn(async () => {})
    const queue = new SingleFlightQueue<string>(runner, () => true)
    queue.enqueue('A', true)
    await new Promise(r => setTimeout(r, 10))
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith('A', true)
  })

  it('de-duplicates repeated enqueues for the same key while it is already queued (not yet running)', async () => {
    const order: string[] = []
    const aGate = deferred<void>()
    const queue = new SingleFlightQueue<string>(
      async key => {
        order.push(`start:${key}`)
        if (key === 'X') await aGate.promise
        order.push(`end:${key}`)
      },
      () => false,
    )

    queue.enqueue('X') // occupies the in-flight slot
    await new Promise(r => setTimeout(r, 5))
    queue.enqueue('B')
    queue.enqueue('B') // duplicate — should not run B twice
    aGate.resolve()
    await new Promise(r => setTimeout(r, 20))

    expect(order.filter(e => e === 'start:B').length).toBe(1)
  })

  it('currentlyInFlight reflects the key actively running, and null when idle', async () => {
    const gate = deferred<void>()
    const queue = new SingleFlightQueue<string>(
      async () => {
        await gate.promise
      },
      () => false,
    )
    expect(queue.currentlyInFlight).toBeNull()
    queue.enqueue('A')
    await new Promise(r => setTimeout(r, 5))
    expect(queue.currentlyInFlight).toBe('A')
    gate.resolve()
    await new Promise(r => setTimeout(r, 10))
    expect(queue.currentlyInFlight).toBeNull()
  })
})
