// Core/Legacy Watch AI detection state machine (detectionController.ts) —
// cross-SKU isolation, stale-response handling, circuit breaker, and the
// interaction with the single automatic retry in boundaryDetection.ts. The
// controller is pure (no React), so these drive the SAME code the
// AnnotationProvider runs; the last block plugs in the real detectBoundaries()
// (mocked fetch only) to prove a recovered retry never counts as a failure.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DetectionController, detectionBadge, type DetectionTraceEvent } from '../apps/desktop/src/context/detectionController'
import { detectBoundaries } from '../apps/desktop/electron/services/boundaryDetection'
import type { BoundaryDetectResult } from '../apps/desktop/src/types/ipc'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const REAL_WATCH_IMAGE = join(__dirname, '..', 'sampledata', '1688KM11.png')

const OK: BoundaryDetectResult = { ok: true, spliceBoundaries: { leftBoundary: 10, rightBoundary: 90 }, scaleBoundaries: { leftBoundary: 10, rightBoundary: 90 }, confidence: null }
const FAIL = (msg = 'x'): BoundaryDetectResult => ({ ok: false, error: 'No boundaries detected for this image.', retryable: false, code: 'no_detection', technicalMessage: msg, attempts: 2 })
const settle = () => new Promise(r => setTimeout(r, 15))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function make(script: (sku: string, requestId: string) => Promise<BoundaryDetectResult | null> | BoundaryDetectResult | null) {
  const trace: DetectionTraceEvent[] = []
  const calls: { sku: string; requestId: string }[] = []
  const c = new DetectionController({
    invoke: async (sku, requestId) => {
      calls.push({ sku, requestId })
      return script(sku, requestId)
    },
    onChange: () => {},
    onTrace: e => trace.push(e),
  })
  return { c, trace, calls }
}

describe('cross-SKU isolation — a failure for one SKU never poisons the others', () => {
  it('failed A -> selecting B, C, D each makes its OWN new request (distinct correlation ids)', async () => {
    const { c, calls } = make(sku => (sku === 'A' ? FAIL() : OK))
    c.select('A'); await settle()
    expect(c.statusOf('A')).toBe('failed')

    for (const sku of ['B', 'C', 'D']) { c.select(sku); await settle() }

    expect(calls.map(x => x.sku)).toEqual(['A', 'B', 'C', 'D'])
    expect(new Set(calls.map(x => x.requestId)).size).toBe(4)
    expect(calls.map(x => x.requestId)).toEqual(['A#1', 'B#2', 'C#3', 'D#4'])
    for (const sku of ['B', 'C', 'D']) expect(c.statusOf(sku)).toBe('success')
    expect(c.circuitBroken).toBe(false)
  })

  it("A's error can never appear on B (before, during, or after B's own request)", async () => {
    const gateB = deferred<BoundaryDetectResult>()
    const { c } = make(sku => (sku === 'A' ? FAIL('A-only detail') : gateB.promise))
    c.select('A'); await settle()
    expect(c.errorOf('A')?.technicalMessage).toBe('A-only detail')

    expect(c.errorOf('B')).toBeNull()          // before B is requested
    expect(c.statusOf('B')).toBe('idle')
    c.select('B'); await settle()
    expect(c.statusOf('B')).toBe('pending')     // during
    expect(c.errorOf('B')).toBeNull()
    gateB.resolve(OK); await settle()
    expect(c.statusOf('B')).toBe('success')     // after
    expect(c.errorOf('B')).toBeNull()
    expect(c.errorOf('A')?.technicalMessage).toBe('A-only detail') // and B's success doesn't erase A's own error
    expect(c.statusOf('A')).toBe('failed')
  })

  it("A's late failure (still in flight when B is selected) neither overwrites nor blocks B", async () => {
    const gateA = deferred<BoundaryDetectResult>()
    const { c, calls, trace } = make(sku => (sku === 'A' ? gateA.promise : OK))
    c.select('A'); await settle()
    c.select('B'); await settle()
    expect(calls.map(x => x.sku)).toEqual(['A'])  // single-flight: B waits its turn, it is not dropped
    expect(c.statusOf('B')).toBe('idle')

    gateA.resolve(FAIL('late A failure')); await settle()
    expect(c.statusOf('A')).toBe('failed')
    expect(calls.map(x => x.sku)).toEqual(['A', 'B']) // B's request happened right after A settled
    expect(c.statusOf('B')).toBe('success')
    expect(c.errorOf('B')).toBeNull()
    expect(trace.filter(e => e.type === 'discarded-stale')).toEqual([])
  })

  it('a stale response for a sku (superseded by a newer request for that same sku) is discarded and cannot overwrite the newer result', async () => {
    const first = deferred<BoundaryDetectResult>()
    let n = 0
    const { c, trace } = make(() => (++n === 1 ? first.promise : OK))
    // Force the impossible-through-the-queue situation directly (defense in depth): two overlapping runs for one sku.
    const run = (c as unknown as { runOnce(sku: string, force: boolean): Promise<void> }).runOnce.bind(c)
    const p1 = run('A', true)   // older request, still pending
    const p2 = run('A', true)   // newer request supersedes it
    await p2
    expect(c.statusOf('A')).toBe('success')
    first.resolve(FAIL('older, stale failure')) // arrives AFTER the newer success
    await p1
    expect(c.statusOf('A')).toBe('success')
    expect(c.errorOf('A')).toBeNull()
    expect(c.consecutiveFailures).toBe(0)
    expect(trace.some(e => e.type === 'discarded-stale' && e.sku === 'A')).toBe(true)
  })

  it('a duplicate request for the sku already in flight (Retry / auto-recovery tick) is dropped, so it cannot clobber the in-flight result', async () => {
    const gate = deferred<BoundaryDetectResult>()
    const { c, calls } = make(() => gate.promise)
    c.select('A'); await settle()
    c.retry('A'); c.retry('A')
    gate.resolve(OK); await settle()
    expect(calls).toHaveLength(1)
    expect(c.statusOf('A')).toBe('success')
  })
})

describe('circuit breaker — limits load but never blocks later SKUs from being requested', () => {
  it('3 consecutive failures open it; the NEXT selected sku still gets its own probe request, and a success closes the breaker', async () => {
    const { c, calls } = make(sku => (['A', 'B', 'C'].includes(sku) ? FAIL() : OK))
    for (const sku of ['A', 'B', 'C']) { c.select(sku); await settle() }
    expect(c.circuitBroken).toBe(true)

    c.select('D'); await settle()
    expect(calls.map(x => x.sku)).toEqual(['A', 'B', 'C', 'D']) // before the fix D was never requested at all
    expect(c.statusOf('D')).toBe('success')
    expect(c.circuitBroken).toBe(false)
    expect(c.errorOf('D')).toBeNull()
  })

  it('while open, look-ahead prefetch is disabled and a selection made while another request is outstanding is not piled on', async () => {
    const gate = deferred<BoundaryDetectResult>()
    const { c, calls, trace } = make(sku => (sku === 'X' ? gate.promise : FAIL()))
    for (const sku of ['A', 'B', 'C']) { c.select(sku); await settle() }
    expect(c.circuitBroken).toBe(true)

    c.prefetch('P'); await settle()
    expect(calls.map(x => x.sku)).toEqual(['A', 'B', 'C']) // no prefetch while open

    c.select('X'); await settle()      // probe in flight
    c.select('Y'); await settle()      // would pile on -> skipped
    expect(calls.map(x => x.sku)).toEqual(['A', 'B', 'C', 'X'])
    expect(trace.some(e => e.type === 'skipped' && e.sku === 'Y')).toBe(true)
    gate.resolve(OK); await settle()
    expect(c.circuitBroken).toBe(false)
  })

  it('a sku that already has its own result is not re-requested just because it is selected again', async () => {
    const { c, calls } = make(() => FAIL())
    c.select('A'); await settle()
    c.select('A'); await settle()
    expect(calls).toHaveLength(1)
  })

  it('an IPC-level crash settles the sku as failed (never stuck "pending") with a structured error', async () => {
    const { c } = make(() => { throw new Error('ipc exploded') })
    c.select('A'); await settle()
    expect(c.statusOf('A')).toBe('failed')
    expect(c.errorOf('A')).toMatchObject({ code: 'network', technicalMessage: 'ipc exploded' })
  })
})

describe('AI Detection badge — the global breaker message never overrides a SKU that has its own successful detection', () => {
  const badgeOf = (c: DetectionController, sku: string) => detectionBadge(c.statusOf(sku), c.circuitBroken)

  it('A fails repeatedly -> breaker open; B selected and its probe succeeds -> B shows success, A keeps its own failure', async () => {
    const { c } = make(sku => (['A1', 'A2', 'A'].includes(sku) ? FAIL('A detail') : OK))
    for (const sku of ['A1', 'A2', 'A']) { c.select(sku); await settle() }
    expect(c.circuitBroken).toBe(true)
    expect(badgeOf(c, 'A')).toBe('unavailable')

    c.select('B')
    expect(badgeOf(c, 'B')).toBe('detecting') // its probe is in flight: "Detecting…", not the global message
    await settle()
    expect(c.statusOf('B')).toBe('success')
    expect(badgeOf(c, 'B')).toBe('success')
    expect(c.errorOf('B')).toBeNull()
    expect(c.circuitBroken).toBe(false)
    // A's failure stays A's: still failed, still its own detail, and no longer "unavailable" once the service is back.
    expect(c.statusOf('A')).toBe('failed')
    expect(c.errorOf('A')?.technicalMessage).toBe('A detail')
    expect(badgeOf(c, 'A')).toBe('failed')
  })

  it('even while the breaker is still OPEN (it opened after B succeeded), B keeps showing success — the presentation is per-SKU first', async () => {
    const { c } = make(sku => (sku === 'B' ? OK : FAIL()))
    c.select('B'); await settle()
    for (const sku of ['X', 'Y', 'Z']) { c.select(sku); await settle() }
    expect(c.circuitBroken).toBe(true)
    expect(badgeOf(c, 'B')).toBe('success')      // not "unavailable"
    expect(badgeOf(c, 'X')).toBe('unavailable')  // the failed ones still reflect the outage
    expect(detectionBadge('pending', true)).toBe('detecting')
  })

  it('automatic recovery: the retry of the current sku succeeds -> success badge, breaker closed, stale error cleared', async () => {
    let healthy = false
    const { c } = make(() => (healthy ? OK : FAIL('outage')))
    for (const sku of ['A', 'B', 'C']) { c.select(sku); await settle() }
    expect(c.circuitBroken).toBe(true)
    expect(badgeOf(c, 'C')).toBe('unavailable')

    healthy = true
    c.retry('C') // exactly what the circuit-breaker auto-recovery tick (and the Retry button) calls
    await settle()
    expect(c.statusOf('C')).toBe('success')
    expect(c.errorOf('C')).toBeNull()
    expect(c.circuitBroken).toBe(false)
    expect(badgeOf(c, 'C')).toBe('success')
    expect(badgeOf(c, 'A')).toBe('failed') // earlier skus keep their own failure, without the global message
    expect(c.errorOf('A')?.technicalMessage).toBe('outage')
  })

  it('badge table', () => {
    expect(detectionBadge('success', true)).toBe('success')
    expect(detectionBadge('success', false)).toBe('success')
    expect(detectionBadge('failed', true)).toBe('unavailable')
    expect(detectionBadge('failed', false)).toBe('failed')
    expect(detectionBadge('idle', false)).toBe('detecting')
    expect(detectionBadge('idle', true)).toBe('unavailable')
  })
})

describe('interaction with the single automatic retry (real detectBoundaries, mocked fetch)', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  const stale = () => new Response(JSON.stringify({ success: false, message: '[StatusCode.UNAVAILABLE] recvmsg:Connection timed out', case_bbox: null, dial_bbox: null }), { status: 200 })
  const good = () => new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [10, 0, 90, 100], dial_bbox: [20, 10, 80, 90] }), { status: 200 })
  const real = (sku: string, requestId: string) => detectBoundaries(REAL_WATCH_IMAGE, 'Case', undefined, requestId)

  it('a first attempt that fails but is recovered by the retry is a plain success: it never counts toward the circuit breaker', async () => {
    let call = 0
    globalThis.fetch = vi.fn(async () => (++call % 2 === 1 ? stale() : good())) as unknown as typeof fetch // every sku: stale, then good
    const c = new DetectionController({ invoke: real, onChange: () => {} })
    for (const sku of ['A', 'B', 'C', 'D', 'E']) { c.select(sku); await new Promise(r => setTimeout(r, 60)) }

    expect(globalThis.fetch).toHaveBeenCalledTimes(10) // 2 sequential requests per sku
    for (const sku of ['A', 'B', 'C', 'D', 'E']) {
      expect(c.statusOf(sku)).toBe('success')
      expect(c.errorOf(sku)).toBeNull()
    }
    expect(c.consecutiveFailures).toBe(0)
    expect(c.circuitBroken).toBe(false)
  })

  it('both attempts failing is ONE failure per sku (attempts: 2) — it takes three failed SKUs, not two requests, to open the breaker', async () => {
    globalThis.fetch = vi.fn(async () => stale()) as unknown as typeof fetch
    const c = new DetectionController({ invoke: real, onChange: () => {} })

    c.select('A'); await new Promise(r => setTimeout(r, 60))
    expect(c.errorOf('A')).toMatchObject({ code: 'no_detection', attempts: 2, requestId: 'A#1' })
    expect(c.consecutiveFailures).toBe(1)
    expect(c.circuitBroken).toBe(false)

    c.select('B'); await new Promise(r => setTimeout(r, 60))
    expect(c.consecutiveFailures).toBe(2)
    expect(c.circuitBroken).toBe(false)

    c.select('C'); await new Promise(r => setTimeout(r, 60))
    expect(c.circuitBroken).toBe(true)
    // ...and a later sku still gets requested (2 more fetches = its attempt + retry).
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    c.select('D'); await new Promise(r => setTimeout(r, 60))
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length - before).toBe(2)
    expect(c.errorOf('D')).toMatchObject({ attempts: 2, requestId: 'D#4' })
  })

  it('A fails on both attempts, then B (recovered by retry) succeeds with no trace of A on it', async () => {
    let call = 0
    globalThis.fetch = vi.fn(async () => { call++; return call <= 2 ? stale() : call === 3 ? stale() : good() }) as unknown as typeof fetch
    const c = new DetectionController({ invoke: real, onChange: () => {} })
    c.select('A'); await new Promise(r => setTimeout(r, 60))
    c.select('B'); await new Promise(r => setTimeout(r, 60))
    expect(c.statusOf('A')).toBe('failed')
    expect(c.statusOf('B')).toBe('success')
    expect(c.errorOf('B')).toBeNull()
    expect(c.consecutiveFailures).toBe(0)
  })
})
