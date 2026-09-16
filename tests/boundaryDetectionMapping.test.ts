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
  it('maps a real captured success response to scaleBoundaries only, never spliceBoundaries', () => {
    const fixture = loadFixture('success-1688KM11.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth)
    expect(result).toEqual(fixture.expected)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spliceBoundaries).toBeNull()
      expect(result.confidence).toBeNull()
      expect(result.scaleBoundaries).toEqual({ leftBoundary: 263, rightBoundary: 1312 })
    }
  })

  it('maps a real captured success:false response to a generic failure, never surfacing the raw message text', () => {
    const fixture = loadFixture('failure-no-detection.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retryable).toBe(fixture.expected.retryable)
      // The raw API message is an internal exception string — the mapping
      // must never leak it verbatim into the app's error surface.
      expect(result.error).not.toContain(fixture.response.message)
    }
  })

  it('clamps a bbox that overshoots the image bounds on both sides', () => {
    const fixture = loadFixture('edge-case-out-of-bounds-bbox.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth)
    expect(result).toEqual(fixture.expected)
  })

  it('rejects a bbox whose clamped width is below MIN_GUIDE_SEPARATION as a detection failure, not garbage guides', () => {
    const fixture = loadFixture('edge-case-implausible-bbox.json')
    const result = mapSegmentationResponse(fixture.response, fixture.imageWidth)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(fixture.expected.retryable)
  })

  it('rejects a malformed bbox (wrong length / non-finite values) as a detection failure', () => {
    expect(mapSegmentationResponse({ success: true, message: '', bbox: [1, 2, 3] }, 1000).ok).toBe(false)
    expect(mapSegmentationResponse({ success: true, message: '', bbox: [1, 2, NaN, 4] }, 1000).ok).toBe(false)
    expect(mapSegmentationResponse({ success: true, message: '', bbox: null }, 1000).ok).toBe(false)
  })

  it('treats out-of-order bbox x-coordinates (x2 < x1) as still valid, taking min/max', () => {
    const result = mapSegmentationResponse({ success: true, message: '', bbox: [800, 5, 200, 900] }, 1000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scaleBoundaries).toEqual({ leftBoundary: 200, rightBoundary: 800 })
  })
})

describe('detectBoundaries — network behavior (mocked fetch, real image file)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('does not retry a well-formed success:false response (not a network failure)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, message: 'x', bbox: null }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(false)
  })

  it('retries exactly once on a network-level failure, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, message: 'ok', bbox: [10, 0, 90, 100] }), { status: 200 }),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
  })

  it('gives up as retryable after two consecutive network-level failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(true)
  })

  it('reports a non-2xx HTTP response as retryable without treating it as a network failure (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(true)
  })

  it('never populates spliceBoundaries regardless of outcome', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, message: 'ok', bbox: [10, 0, 90, 100] }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await detectBoundaries(REAL_WATCH_IMAGE)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.spliceBoundaries).toBeNull()
  })
})
