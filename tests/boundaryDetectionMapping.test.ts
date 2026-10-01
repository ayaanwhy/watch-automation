import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapSegmentationResponse, detectBoundaries, getDetectionFailureInfo } from '../apps/desktop/electron/services/boundaryDetection'
import { nextCircuitRetryDelayMs, shouldTripCircuitBreaker } from '../apps/desktop/src/context/AnnotationContext'

// boundaryDetection.ts's logger import needs app.getPath — same pattern as
// workflowPreparation.test.ts/batchRegistryRecovery.test.ts (vi.mock calls
// are hoisted above imports by vitest, so this applies before the import
// above runs). A real temp dir (not asserted against) since only
// mapSegmentationResponse/detectBoundaries's return values are under test
// here, not logging.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}))

const FIXTURES_DIR = join(__dirname, 'fixtures', 'boundaryApi')
const REAL_WATCH_IMAGE = join(__dirname, '..', 'sampledata', '1688KM11.png')

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8'))
}

describe('mapSegmentationResponse — Phase 14B contract mapping (pure, no network)', () => {
  // Finalized 2026-09-18 against the real two-box API (verified with both
  // boxes overlaid on the same real image simultaneously): case_bbox is
  // the watch CASE boundary (confirmed by the AI team 2026-09-17, then the
  // API itself split its single `bbox` field into `case_bbox`/`dial_bbox`
  // on 2026-09-18) — it maps to spliceBoundaries always, and to
  // scaleBoundaries for Measure By 'Case' (mirrored — no separate scale
  // concept exists for Case watches). For 'Dial', scaleBoundaries comes
  // from dial_bbox, extracted/clamped the same way; null only if dial_bbox
  // itself is absent/invalid on that response (a genuine partial success).

  it('maps a real captured success response to spliceBoundaries, and mirrors case_bbox into scaleBoundaries for Measure By Case', () => {
    const fixture = loadFixture('success-1688KM11.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth, 'Case')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spliceBoundaries).toEqual({ leftBoundary: 263, rightBoundary: 1312 })
      expect(result.scaleBoundaries).toEqual({ leftBoundary: 263, rightBoundary: 1312 })
      expect(result.confidence).toBeNull()
    }
  })

  it('maps the same real captured response to spliceBoundaries from case_bbox and scaleBoundaries from dial_bbox for Measure By Dial', () => {
    const fixture = loadFixture('success-1688KM11.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth, 'Dial')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spliceBoundaries).toEqual({ leftBoundary: 263, rightBoundary: 1312 })
      expect(result.scaleBoundaries).toEqual({ leftBoundary: 356, rightBoundary: 1212 })
      expect(result.confidence).toBeNull()
    }
  })

  it('treats a real response with case_bbox but no dial_bbox as a partial success for Measure By Dial (splice populated, scale null)', () => {
    const fixture = loadFixture('edge-case-dial-not-detected.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth, 'Dial')
    expect(result).toEqual(fixture.expectedForDial)
  })

  it('Measure By comparison is case-insensitive, mirroring AnnotationCanvas.tsx\'s own convention', () => {
    const fixture = loadFixture('success-1688KM11.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth, 'dial')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scaleBoundaries).toEqual({ leftBoundary: 356, rightBoundary: 1212 })
  })

  it('maps a real captured success:false response to a generic failure, never surfacing the raw message text', () => {
    const fixture = loadFixture('failure-no-detection.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth, 'Case')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retryable).toBe(fixture.expected.retryable)
      // The raw API message is an internal exception string — the mapping
      // must never leak it verbatim into the app's error surface.
      expect(result.error).not.toContain(fixture.response.message)
    }
  })

  it('clamps a bbox that overshoots the image bounds on both sides (Case: mirrored; Dial: splice only)', () => {
    const fixture = loadFixture('edge-case-out-of-bounds-bbox.json')
    expect(mapSegmentationResponse(fixture.response, fixture.imageWidth, 'Case')).toEqual(fixture.expectedForCase)
    expect(mapSegmentationResponse(fixture.response, fixture.imageWidth, 'Dial')).toEqual(fixture.expectedForDial)
  })

  it('rejects a bbox whose clamped width is below MIN_GUIDE_SEPARATION as a detection failure, not garbage guides', () => {
    const fixture = loadFixture('edge-case-implausible-bbox.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth, 'Case')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(fixture.expected.retryable)
  })

  it('rejects a malformed bbox (wrong length / non-finite values) as a detection failure', () => {
    expect(mapSegmentationResponse({ success: true, message: '', case_bbox: [1, 2, 3] }, 1000, 'Case').ok).toBe(false)
    expect(mapSegmentationResponse({ success: true, message: '', case_bbox: [1, 2, NaN, 4] }, 1000, 'Case').ok).toBe(false)
    expect(mapSegmentationResponse({ success: true, message: '', case_bbox: null }, 1000, 'Case').ok).toBe(false)
  })

  it('treats out-of-order bbox x-coordinates (x2 < x1) as still valid, taking min/max', () => {
    const result = mapSegmentationResponse({ success: true, message: '', case_bbox: [800, 5, 200, 900] }, 1000, 'Case')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.spliceBoundaries).toEqual({ leftBoundary: 200, rightBoundary: 800 })
  })

  it('rejects an implausible dial_bbox (below MIN_GUIDE_SEPARATION) without failing the whole result — scaleBoundaries stays null, spliceBoundaries still populates', () => {
    const result = mapSegmentationResponse(
      { success: true, message: '', case_bbox: [100, 5, 900, 900], dial_bbox: [500, 5, 503, 900] },
      1000,
      'Dial',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spliceBoundaries).toEqual({ leftBoundary: 100, rightBoundary: 900 })
      expect(result.scaleBoundaries).toBeNull()
    }
  })

  it('ignores dial_bbox entirely for Measure By Case, even if present', () => {
    const result = mapSegmentationResponse(
      { success: true, message: '', case_bbox: [100, 5, 900, 900], dial_bbox: [300, 50, 700, 850] },
      1000,
      'Case',
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scaleBoundaries).toEqual({ leftBoundary: 100, rightBoundary: 900 })
  })
})

describe('detectBoundaries — network behavior (mocked fetch, real image file)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('retries a well-formed success:false / null case_bbox response exactly once (then reports it non-retryable, as before)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: false, message: 'x', case_bbox: null }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(false)
  })

  it('retries exactly once on a network-level failure, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [10, 0, 90, 100] }), { status: 200 }),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
  })

  it('gives up as retryable after two consecutive network-level failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(true)
  })

  it('reports a non-2xx HTTP response as retryable without treating it as a network failure (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(true)
  })

  it('threads Measure By through to the mapping end-to-end, extracting both case_bbox and dial_bbox for Dial', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [10, 0, 90, 100], dial_bbox: [20, 10, 80, 90] }), {
          status: 200,
        }),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Dial')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spliceBoundaries).toEqual({ leftBoundary: 10, rightBoundary: 90 })
      expect(result.scaleBoundaries).toEqual({ leftBoundary: 20, rightBoundary: 80 })
    }
  })

  it('a Dial response missing dial_bbox still ends-to-end resolves splice from case_bbox, scale null', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [10, 0, 90, 100] }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Dial')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spliceBoundaries).toEqual({ leftBoundary: 10, rightBoundary: 90 })
      expect(result.scaleBoundaries).toBeNull()
    }
  })

  // Phase 15.0 — proves the module-level SingleFlightQueue wrap on
  // detectBoundaries() itself, not just the abstract queue class in
  // isolation (see mainProcessSingleFlightQueue.test.ts). Two calls here
  // simulate two genuinely independent callers — e.g. Legacy's
  // boundary:detect IPC handler and Sandbox's headless Watch runner —
  // both invoking the same exported function with no coordination between
  // them, exactly the scenario the earlier renderer-only fix
  // (AnnotationContext.tsx) could not cover.
  it('two independent callers of detectBoundaries() never have overlapping requests in flight', async () => {
    let inFlight = 0
    let maxConcurrent = 0

    const fetchMock = vi.fn(async () => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise(r => setTimeout(r, 15))
      inFlight--
      return new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [10, 0, 90, 100] }), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // "Caller A" (e.g. Legacy IPC handler) and "Caller B" (e.g. Sandbox
    // headless runner) both call detectBoundaries() at essentially the
    // same instant, with no awareness of each other.
    const callerA = detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    const callerB = detectBoundaries(REAL_WATCH_IMAGE, 'Dial')

    const [resultA, resultB] = await Promise.all([callerA, callerB])

    expect(maxConcurrent, 'no two detectBoundaries() calls should ever hit fetch concurrently').toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)
  })
})

// 2026-09-30 — Core/Legacy Watch AI detection diagnostic fix. Every failure
// path now carries a full, IPC-serializable structured shape (code,
// technicalMessage, httpStatus, durationMs, endpoint, attempts, cause), not
// just the pre-existing free-text `error`/`retryable` pair — this is what
// lets InfoPanel show a real Details/debug path instead of a single
// collapsed "AI detection unavailable" string. getDetectionFailureInfo
// (Sandbox's existing consumer, unchanged) must keep working identically —
// asserted directly against the same result object here.
describe('detectBoundaries — structured failure diagnostics (endpoint, duration, HTTP status, attempts, cause)', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('a successful response carries no failure fields at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [10, 0, 90, 100] }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(result.ok).toBe(true)
    expect(getDetectionFailureInfo(result)).toBeNull()
  })

  it('timeout: every request aborts -> code "timeout", retryable, 2 attempts, endpoint + duration + cause populated', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result).toMatchObject({ code: 'timeout', retryable: true, attempts: 2, endpoint: 'https://watchdialcoord.clouddeploy.in' })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.cause).toContain('AbortError')
    expect(result.technicalMessage).toMatch(/attempt/i)
    // The concise error string stays short and generic — the diagnostic detail lives in technicalMessage/cause, not error.
    expect(result.error).toBe('Detection request timed out.')
    expect(getDetectionFailureInfo(result)).toEqual({ reason: 'timeout', httpStatus: undefined, attempts: 2 })
  })

  it('network failure (non-abort): code "network", cause carries the underlying error, retries once then gives up', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result).toMatchObject({ code: 'network', retryable: true, attempts: 2 })
    expect(result.cause).toContain('ECONNREFUSED')
    expect(result.error).toBe('Could not reach the detection service.')
  })

  it('HTTP error: code "http_error", httpStatus set, response body excerpt kept in technicalMessage (never in error)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('upstream model server unavailable', { status: 503, statusText: 'Service Unavailable' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(fetchMock).toHaveBeenCalledTimes(1) // a well-formed HTTP response is never retried
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result).toMatchObject({ code: 'http_error', retryable: true, httpStatus: 503, attempts: 1 })
    expect(result.technicalMessage).toContain('503')
    expect(result.technicalMessage).toContain('upstream model server unavailable')
    expect(result.error).not.toContain('upstream model server unavailable')
    expect(getDetectionFailureInfo(result)).toEqual({ reason: 'http_error', httpStatus: 503, attempts: 1 })
  })

  it('malformed/invalid JSON response: code "malformed_response", the raw body is kept in technicalMessage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('malformed_response')
    expect(result.technicalMessage).toContain('502 Bad Gateway')
  })

  it('success:false (API "no boundaries" outcome): code "no_detection", the API\'s own free-text message reaches technicalMessage but never `error`', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, message: 'attempt to get argmax of an empty sequence', case_bbox: null, dial_bbox: null }), { status: 200 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('no_detection')
    expect(result.retryable).toBe(false)
    expect(result.error).not.toContain('argmax')
    expect(result.technicalMessage).toContain('argmax')
    // mapSegmentationResponse-derived failures are still enriched with the request-level fields.
    expect(result.endpoint).toBe('https://watchdialcoord.clouddeploy.in')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.attempts).toBe(2) // the original request + the single automatic retry
    expect(getDetectionFailureInfo(result)).toEqual({ reason: 'no_detection', httpStatus: undefined, attempts: 2 })
  })

  it('implausible bbox: code "implausible", the rejected coordinates are in technicalMessage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [500, 5, 503, 100], dial_bbox: null }), { status: 200 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(join(__dirname, '..', 'sampledata', '1688KM11.png'), 'Case')
    // sampledata/1688KM11.png is 1696px wide — [500,503] is a 3px span, well under MIN_GUIDE_SEPARATION.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('implausible')
    expect(result.technicalMessage).toContain('500')
    expect(result.technicalMessage).toContain('503')
  })

  it('threads a configured endpoint override into every diagnostic field, not just the request URL', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case', 'https://custom-watch-api.example.com/')
    expect(fetchMock).toHaveBeenCalledWith('https://custom-watch-api.example.com/bbox/predict', expect.anything())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.endpoint).toBe('https://custom-watch-api.example.com')
  })

  // 2026-09-30 — single automatic retry of an HTTP-200 success:false /
  // null case_bbox response. The Watch API's backend returns exactly that shape
  // (message "[StatusCode.UNAVAILABLE] recvmsg:Connection timed out") for the
  // first request after ~6+ min idle, and an immediate second request
  // succeeds. The message is never inspected — only the shape is.
  describe('single automatic retry of success:false / null case_bbox', () => {
    const stale = () => new Response(JSON.stringify({ success: false, message: '[StatusCode.UNAVAILABLE] recvmsg:Connection timed out', case_bbox: null, dial_bbox: null }), { status: 200 })
    const good = () => new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [10, 0, 90, 100], dial_bbox: [20, 10, 80, 90] }), { status: 200 })

    it('first attempt fails, retry succeeds -> a normal success (same request sent twice, sequentially)', async () => {
      let inFlight = 0
      let maxInFlight = 0
      const fetchMock = vi.fn()
        .mockImplementationOnce(async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return stale() })
        .mockImplementationOnce(async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return good() })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Dial', undefined, 'W-1#1')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(maxInFlight).toBe(1)
      expect(result).toMatchObject({ ok: true, spliceBoundaries: { leftBoundary: 10, rightBoundary: 90 }, scaleBoundaries: { leftBoundary: 20, rightBoundary: 80 }, requestId: 'W-1#1' })
      // Identical payload both times: same endpoint, same multipart field, same bytes.
      const bodies = await Promise.all(fetchMock.mock.calls.map(async c => Buffer.from(await (c[1].body as FormData).get('image')!.valueOf().arrayBuffer())))
      expect(bodies[0].equals(bodies[1])).toBe(true)
      expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0])
    })

    it('both attempts fail -> the rich error is preserved and reports attempts: 2 (with the first attempt noted)', async () => {
      const fetchMock = vi.fn(async () => stale())
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case', undefined, 'W-2#1')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result).toMatchObject({ code: 'no_detection', attempts: 2, retryable: false, endpoint: 'https://watchdialcoord.clouddeploy.in', requestId: 'W-2#1' })
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.technicalMessage).toContain('UNAVAILABLE') // API text preserved for Details, never parsed
      expect(result.technicalMessage).toContain('first attempt:')
      expect(result.error).not.toContain('UNAVAILABLE')
      expect(getDetectionFailureInfo(result)).toMatchObject({ reason: 'no_detection', attempts: 2 })
    })

    it('a network error on the retry itself is reported truthfully (network, attempts adds up)', async () => {
      const fetchMock = vi.fn().mockImplementationOnce(async () => stale()).mockRejectedValue(new TypeError('fetch failed: ECONNRESET'))
      globalThis.fetch = fetchMock as unknown as typeof fetch
      const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('network')
      expect(result.attempts).toBe(3) // 1 (stale) + 2 (network attempt + its own transport retry)
    })

    it('does NOT retry other failures: implausible bbox, HTTP 5xx, malformed JSON (each stays a single request)', async () => {
      for (const make of [
        () => new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [500, 5, 503, 100] }), { status: 200 }),
        () => new Response('boom', { status: 502 }),
        () => new Response('<html>', { status: 200 }),
      ]) {
        const fetchMock = vi.fn(async () => make())
        globalThis.fetch = fetchMock as unknown as typeof fetch
        const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
        expect(result.ok).toBe(false)
        expect(fetchMock).toHaveBeenCalledTimes(1)
      }
    })
  })

  // 2026-09-30 — end-to-end correlation id (UI -> IPC -> boundaryDetection ->
  // HTTP -> response -> back to the renderer). Echoed on BOTH success and
  // failure, on every failure path, so one prediction can be followed
  // through the whole pipeline and the renderer can recognize (and discard)
  // a response that arrives after a newer request for the same image has
  // already superseded it.
  it('echoes the caller-supplied requestId back on success and on every failure path', async () => {
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, message: 'ok', case_bbox: [10, 0, 90, 100] }), { status: 200 }))
    globalThis.fetch = ok as unknown as typeof fetch
    const okResult = await detectBoundaries(REAL_WATCH_IMAGE, 'Case', undefined, 'W-1#7')
    expect(okResult.requestId).toBe('W-1#7')

    const httpErr = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    globalThis.fetch = httpErr as unknown as typeof fetch
    const httpResult = await detectBoundaries(REAL_WATCH_IMAGE, 'Case', undefined, 'W-1#8')
    expect(httpResult.ok).toBe(false)
    if (!httpResult.ok) expect(httpResult.requestId).toBe('W-1#8')

    const netErr = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    globalThis.fetch = netErr as unknown as typeof fetch
    const netResult = await detectBoundaries(REAL_WATCH_IMAGE, 'Case', undefined, 'W-1#9')
    expect(netResult.ok).toBe(false)
    if (!netResult.ok) expect(netResult.requestId).toBe('W-1#9')

    const noDetection = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, message: 'x', case_bbox: null }), { status: 200 }))
    globalThis.fetch = noDetection as unknown as typeof fetch
    const noDetResult = await detectBoundaries(REAL_WATCH_IMAGE, 'Case', undefined, 'W-1#10')
    expect(noDetResult.ok).toBe(false)
    if (!noDetResult.ok) expect(noDetResult.requestId).toBe('W-1#10')

    // Omitting it (Sandbox's own direct caller never sets one) is still valid — no crash, just absent.
    globalThis.fetch = ok as unknown as typeof fetch
    const noId = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(noId.requestId).toBeUndefined()
  })

  it('a missing/unreadable source image fails before any network call, with 0 attempts and no httpStatus', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(join(tmpdir(), 'does-not-exist-12345.png'), 'Case')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result).toMatchObject({ code: 'image_unreadable', retryable: false, attempts: 0 })
    expect(result.httpStatus).toBeUndefined()
  })
})

// Circuit breaker trip threshold (Phase 14C, extracted 2026-09-30 for direct
// testability) — AnnotationContext.tsx trips after 3 CONSECUTIVE detection
// failures (any real detectBoundaries() failure: timeout, network, HTTP
// error, malformed response, no_detection, implausible — every reason above
// trips it the same way, since the counter only cares that the call
// resolved `ok: false`) and resets the counter to 0 on the very next
// success. This is that exact 3-strike contract, isolated from React state.
describe('shouldTripCircuitBreaker — 3 consecutive failures trip it, a success resets the count to 0', () => {
  it('does not trip below the threshold', () => {
    expect(shouldTripCircuitBreaker(0)).toBe(false)
    expect(shouldTripCircuitBreaker(1)).toBe(false)
    expect(shouldTripCircuitBreaker(2)).toBe(false)
  })

  it('trips at exactly 3 consecutive failures, and stays tripped past it', () => {
    expect(shouldTripCircuitBreaker(3)).toBe(true)
    expect(shouldTripCircuitBreaker(4)).toBe(true)
    expect(shouldTripCircuitBreaker(100)).toBe(true)
  })

  it('models the real sequence: 2 failures (not tripped), a success (AnnotationContext resets the counter to 0), then 2 more failures still is not tripped', () => {
    let consecutive = 0
    const fail = () => { consecutive += 1; return shouldTripCircuitBreaker(consecutive) }
    const succeed = () => { consecutive = 0 } // mirrors runDetectionOnce's `consecutiveFailuresRef.current = 0` on ok:true

    expect(fail()).toBe(false) // 1
    expect(fail()).toBe(false) // 2
    succeed()
    expect(fail()).toBe(false) // 1 again, not 3 — the reset actually took effect
    expect(fail()).toBe(false) // 2
    expect(fail()).toBe(true) // 3 — now it trips
  })
})

// Circuit-breaker auto-recovery backoff (2026-09-30) — pure schedule
// function, unit-tested directly per this file's existing convention (no
// jsdom/testing-library available to render AnnotationProvider itself; see
// isPrefetchEligible in AnnotationContext.tsx for the same pattern).
describe('nextCircuitRetryDelayMs — circuit-breaker auto-recovery backoff', () => {
  it('starts at the base delay and doubles each attempt, capped at the max', () => {
    expect(nextCircuitRetryDelayMs(0)).toBe(15_000)
    expect(nextCircuitRetryDelayMs(1)).toBe(30_000)
    expect(nextCircuitRetryDelayMs(2)).toBe(60_000)
    expect(nextCircuitRetryDelayMs(3)).toBe(120_000) // would be 120_000 uncapped too
    expect(nextCircuitRetryDelayMs(4)).toBe(120_000) // capped — never grows unbounded on a long outage
    expect(nextCircuitRetryDelayMs(10)).toBe(120_000)
  })

  it('never returns a delay below the base for a non-positive attempt', () => {
    expect(nextCircuitRetryDelayMs(0)).toBe(15_000)
    expect(nextCircuitRetryDelayMs(-1)).toBe(15_000)
  })
})
