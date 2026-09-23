import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapSegmentationResponse, detectBoundaries } from '../apps/desktop/electron/services/boundaryDetection'

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

  it('does not retry a well-formed success:false response (not a network failure)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, message: 'x', case_bbox: null }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE, 'Case')
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
