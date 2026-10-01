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

  // 2026-09-30 diagnostic fix — the exact race behind "AI detection failed"
  // persisting even though the real API had already answered successfully.
  // De-dup previously checked ONLY the pending queue, never the key
  // currently in flight, so a second request for a key already running
  // (e.g. AnnotationContext's trigger effect firing for a sku whose
  // prefetch is still outstanding, or a Retry click landing while the
  // circuit-breaker auto-recovery's own retry for that exact sku is still
  // in flight) got queued as a genuinely separate run — not deduped. Because
  // the two runs are still serialized, they never overlap concurrently, but
  // the SECOND (redundant) run's outcome always overwrites the first's in
  // AnnotationContext's per-sku state — so a real success could be
  // immediately followed by an unnecessary duplicate call that fails (real,
  // observed, transient upstream flakiness makes this entirely possible),
  // flipping the UI from success back to "Detection failed" for an image
  // the API had already answered correctly.
  describe('a key already in flight is authoritative — a further request for the SAME key never starts a second run', () => {
    it('a non-forced request for a key already running is dropped, not queued — the runner is called exactly once', async () => {
      const calls: string[] = []
      const gate = deferred<void>()
      const queue = new SingleFlightQueue<string>(
        async key => {
          calls.push(key)
          await gate.promise
        },
        () => false,
      )

      queue.enqueue('A') // starts running immediately
      await new Promise(r => setTimeout(r, 5))
      expect(queue.currentlyInFlight).toBe('A')

      queue.enqueue('A') // e.g. the trigger effect firing for 'A' while its own prefetch is still outstanding
      queue.enqueue('A')
      await new Promise(r => setTimeout(r, 5))

      gate.resolve()
      await new Promise(r => setTimeout(r, 20))

      expect(calls).toEqual(['A']) // never re-run — the in-flight call was the only one
    })

    it("a FORCED request for a key already running is also dropped — the in-flight call's own result stands, nothing overwrites it afterward", async () => {
      const calls: string[] = []
      const gate = deferred<'ok' | 'fail'>()
      // Simulates AnnotationContext's per-sku state: only ever set by the runner.
      let lastOutcome: 'ok' | 'fail' | null = null
      const queue = new SingleFlightQueue<string>(
        async (key, force) => {
          calls.push(`${key}:${force}`)
          lastOutcome = await gate.promise
        },
        () => false,
      )

      queue.enqueue('A') // e.g. the normal trigger-effect detection for the current sku
      await new Promise(r => setTimeout(r, 5))
      expect(queue.currentlyInFlight).toBe('A')

      // e.g. a Retry click, or the circuit-breaker auto-recovery loop's own
      // next tick, landing on the SAME sku while the first call is still
      // outstanding — this must NOT start a second, overlapping-in-intent run.
      queue.enqueue('A', true)
      await new Promise(r => setTimeout(r, 5))

      // The one real call now resolves successfully.
      gate.resolve('ok')
      await new Promise(r => setTimeout(r, 20))

      expect(calls).toEqual(['A:false']) // the forced duplicate never ran at all
      expect(lastOutcome).toBe('ok') // nothing ran afterward to flip it back to 'fail'
      expect(queue.currentlyInFlight).toBeNull()
    })

    it('once the in-flight run finishes, a FRESH request for that same key (forced or not) runs normally again', async () => {
      const calls: string[] = []
      const gate1 = deferred<void>()
      let secondGate: ReturnType<typeof deferred<void>> | null = null
      const queue = new SingleFlightQueue<string>(
        async key => {
          calls.push(key)
          if (calls.length === 1) await gate1.promise
          else {
            secondGate = deferred<void>()
            await secondGate.promise
          }
        },
        () => false,
      )

      queue.enqueue('A')
      await new Promise(r => setTimeout(r, 5))
      gate1.resolve()
      await new Promise(r => setTimeout(r, 10))
      expect(queue.currentlyInFlight).toBeNull() // truly finished, not just queued

      queue.enqueue('A', true) // a genuinely NEW request, after the first is done — must run
      await new Promise(r => setTimeout(r, 5))
      expect(queue.currentlyInFlight).toBe('A')
      secondGate!.resolve()
      await new Promise(r => setTimeout(r, 10))

      expect(calls).toEqual(['A', 'A'])
    })

    it('a DIFFERENT key is completely unaffected — only same-key requests are coalesced', async () => {
      const calls: string[] = []
      const gate = deferred<void>()
      const queue = new SingleFlightQueue<string>(
        async key => {
          calls.push(key)
          if (key === 'A') await gate.promise
        },
        () => false,
      )

      queue.enqueue('A')
      await new Promise(r => setTimeout(r, 5))
      queue.enqueue('B') // a different sku's prefetch — must still queue normally
      gate.resolve()
      await new Promise(r => setTimeout(r, 20))

      expect(calls).toEqual(['A', 'B'])
    })
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
