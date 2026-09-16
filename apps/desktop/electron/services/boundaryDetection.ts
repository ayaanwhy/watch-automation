// Watch AI boundary detection (Phase 14B) — thin client for the SAM3 Watch
// Segmentation API (watchdialcoord.clouddeploy.in), deployed 2026-09-15.
// Runs in the main process (fs access to read the image, no renderer CORS
// concern, and TLS is this process's to control) per the Phase 14 design.
//
// Contract captured live (not assumed) from the service's own /openapi.json
// plus one real successful call against sampledata/1688KM11.png
// (IMPLEMENTATION_PLAN.md, Phase 14, has the full probe record):
//   POST /bbox/predict, multipart field `image` (raw bytes) →
//   { success: boolean, message: string, bbox: [number,number,number,number] | null }
// bbox is [x1, y1, x2, y2] in the source image's own pixel space (verified
// by overlaying the exact returned rectangle onto the unmodified source
// image and confirming it lands on the case/bezel edges) — the watch
// case/dial region only, never the bracelet/straps. It therefore maps to
// scaleBoundaries exclusively; this provider has no opinion on
// spliceBoundaries, which stays null unconditionally. The y-values are
// unused — this app's boundary model is 1D (x-only), see types/annotation.ts.
// The live schema has no confidence field at all, so confidence is always
// null here — not a stand-in for "not wired up yet."
//
// `message` is a free-text, apparently-internal string (a raw Python
// exception leaked through on a real captured failure — see fixtures) and
// is deliberately never inspected for meaning; success:false is the only
// signal this module trusts.
//
// TLS: no special handling — the service presents a real Let's Encrypt
// certificate for its own hostname as of the 2026-09-15 re-probe, so
// Node's default strict verification (which the global fetch already
// performs) is sufficient. No pinning, no bypass.
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { logger } from '../logger'
import { MIN_GUIDE_SEPARATION } from '../../src/types/annotation'
import type { BoundaryDetectResult } from '../../src/types/ipc'

const DEFAULT_ENDPOINT = 'https://watchdialcoord.clouddeploy.in'
const REQUEST_TIMEOUT_MS = 10_000

interface SegmentationResponse {
  success: boolean
  message: string
  bbox: unknown
}

function isFiniteQuad(bbox: unknown): bbox is [number, number, number, number] {
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every(n => typeof n === 'number' && Number.isFinite(n))
}

// Pure — no I/O — so it's directly testable against captured/constructed
// fixtures without a network call. Everything network-shaped (timeout,
// retry, TLS) lives only in detectBoundaries below.
export function mapSegmentationResponse(parsed: SegmentationResponse, imageWidth: number): BoundaryDetectResult {
  if (!parsed.success || !isFiniteQuad(parsed.bbox)) {
    return { ok: false, error: 'No boundaries detected for this image.', retryable: false }
  }

  const [x1, , x2] = parsed.bbox
  const left = Math.max(0, Math.min(x1, x2, imageWidth))
  const right = Math.max(0, Math.min(Math.max(x1, x2), imageWidth))

  if (!(right - left >= MIN_GUIDE_SEPARATION)) {
    logger.warn(`boundary-detection — rejected implausible bbox [${x1},${x2}] for image width ${imageWidth}`)
    return { ok: false, error: 'Detected boundaries were implausible.', retryable: false }
  }

  return { ok: true, spliceBoundaries: null, scaleBoundaries: { leftBoundary: left, rightBoundary: right }, confidence: null }
}

async function postPredict(endpoint: string, imageBuffer: Buffer): Promise<Response> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(imageBuffer)]), 'image.png')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(`${endpoint}/bbox/predict`, { method: 'POST', body: form, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

// One transparent retry on a network-level failure only (connection error,
// timeout) — never on a well-formed success:false response, which is a
// normal "no detection" outcome, not a fault. This is distinct from 14C's
// later user-facing Retry button (a fresh, user-initiated call).
export async function detectBoundaries(imagePath: string, endpointOverride?: string | null): Promise<BoundaryDetectResult> {
  const endpoint = (endpointOverride?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '')

  let imageBuffer: Buffer
  let imageWidth: number
  try {
    imageBuffer = await readFile(imagePath)
    const metadata = await sharp(imageBuffer).metadata()
    if (!metadata.width) throw new Error('image has no readable width')
    imageWidth = metadata.width
  } catch (err) {
    logger.warn(`boundary-detection — failed to read image ${imagePath}`, err)
    return { ok: false, error: 'Could not read the image file for detection.', retryable: false }
  }

  let response: Response | null = null
  let lastNetworkError: unknown = null
  for (let attempt = 0; attempt < 2 && response === null; attempt++) {
    try {
      response = await postPredict(endpoint, imageBuffer)
    } catch (err) {
      lastNetworkError = err
    }
  }

  if (response === null) {
    const aborted = lastNetworkError instanceof Error && lastNetworkError.name === 'AbortError'
    logger.warn(`boundary-detection — request failed after retry (${aborted ? 'timeout' : 'network'})`, lastNetworkError)
    return {
      ok: false,
      error: aborted ? 'Detection request timed out.' : 'Could not reach the detection service.',
      retryable: true,
    }
  }

  if (!response.ok) {
    logger.warn(`boundary-detection — HTTP ${response.status} from detection service`)
    return { ok: false, error: `Detection service returned an error (HTTP ${response.status}).`, retryable: true }
  }

  let parsed: SegmentationResponse
  try {
    parsed = await response.json()
  } catch (err) {
    logger.warn('boundary-detection — response was not valid JSON', err)
    return { ok: false, error: 'Detection service returned an unreadable response.', retryable: true }
  }

  return mapSegmentationResponse(parsed, imageWidth)
}
