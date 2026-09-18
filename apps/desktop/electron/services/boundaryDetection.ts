// Watch AI boundary detection (Phase 14B) — thin client for the SAM3 Watch
// Segmentation API (watchdialcoord.clouddeploy.in), deployed 2026-09-15.
// Runs in the main process (fs access to read the image, no renderer CORS
// concern, and TLS is this process's to control) per the Phase 14 design.
//
// Contract captured live (not assumed) from the service's own /openapi.json
// plus real successful calls against sampledata/1688KM11.png
// (IMPLEMENTATION_PLAN.md, Phase 14, has the full probe record):
//   POST /bbox/predict, multipart field `image` (raw bytes) →
//   { success: boolean, message: string, case_bbox: [n,n,n,n]|null, dial_bbox: [n,n,n,n]|null }
// Both boxes are [x1, y1, x2, y2] in the source image's own pixel space —
// verified 2026-09-18 by overlaying both returned rectangles onto the
// unmodified source image simultaneously: case_bbox wraps the case/bezel
// (lug-to-lug), dial_bbox is a tighter, nested box wrapping the dial face
// specifically, excluding the case/bezel ring. The y-values are unused —
// this app's boundary model is 1D (x-only), see types/annotation.ts.
//
// Mapping (per the AI team's confirmation, 2026-09-17, verified against
// the real two-box response, 2026-09-18): case_bbox always maps to
// spliceBoundaries. scaleBoundaries mirrors case_bbox for Measure By
// 'Case' (no separate scale concept exists for Case watches — see
// AnnotationCanvas.tsx's own showScaleGuides gate); for 'Dial' it is
// dial_bbox, extracted/clamped the same way. A well-formed response whose
// case_bbox succeeded but whose dial_bbox is null/invalid on a Dial watch
// is still a genuine partial success (splice population is still useful
// on its own), not a failure — scaleBoundaries is simply null in that case.
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
import type { BoundaryDetectResult, BoundaryPredictionPair } from '../../src/types/ipc'

const DEFAULT_ENDPOINT = 'https://watchdialcoord.clouddeploy.in'
const REQUEST_TIMEOUT_MS = 10_000

interface SegmentationResponse {
  success: boolean
  message: string
  case_bbox: unknown
  dial_bbox: unknown
}

function isFiniteQuad(bbox: unknown): bbox is [number, number, number, number] {
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every(n => typeof n === 'number' && Number.isFinite(n))
}

// Mirrors AnnotationCanvas.tsx's existing `measureBy.toLowerCase() === 'dial'`
// convention exactly, so "what counts as Dial" is defined in exactly one
// place in spirit (case-insensitive, everything else treated as Case).
function isDialMeasured(measureBy: string): boolean {
  return measureBy.toLowerCase() === 'dial'
}

// Clamps a raw [x1, x2] pair into [0, imageWidth] and rejects it (returns
// null) if what remains is narrower than MIN_GUIDE_SEPARATION — a rejected
// pair is a detection failure, never garbage guides.
function clampPair(x1: number, x2: number, imageWidth: number): BoundaryPredictionPair | null {
  const left = Math.max(0, Math.min(x1, x2, imageWidth))
  const right = Math.max(0, Math.min(Math.max(x1, x2), imageWidth))
  if (!(right - left >= MIN_GUIDE_SEPARATION)) return null
  return { leftBoundary: left, rightBoundary: right }
}

// Pure — no I/O — so it's directly testable against captured/constructed
// fixtures without a network call. Everything network-shaped (timeout,
// retry, TLS) lives only in detectBoundaries below.
export function mapSegmentationResponse(
  parsed: SegmentationResponse,
  imageWidth: number,
  measureBy: string,
): BoundaryDetectResult {
  if (!parsed.success || !isFiniteQuad(parsed.case_bbox)) {
    return { ok: false, error: 'No boundaries detected for this image.', retryable: false }
  }

  const [caseX1, , caseX2] = parsed.case_bbox
  const caseBoundary = clampPair(caseX1, caseX2, imageWidth)
  if (caseBoundary === null) {
    logger.warn(`boundary-detection — rejected implausible case bbox [${caseX1},${caseX2}] for image width ${imageWidth}`)
    return { ok: false, error: 'Detected boundaries were implausible.', retryable: false }
  }

  // Dial watches use dial_bbox for scaleBoundaries (extracted/clamped the
  // same way as caseBoundary); a missing or implausible dial_bbox doesn't
  // fail the whole result — spliceBoundaries from case_bbox is still a
  // useful partial success. Case watches mirror case_bbox into
  // scaleBoundaries (see this file's header comment).
  let scaleBoundaries: BoundaryPredictionPair | null
  if (!isDialMeasured(measureBy)) {
    scaleBoundaries = caseBoundary
  } else if (isFiniteQuad(parsed.dial_bbox)) {
    const [dialX1, , dialX2] = parsed.dial_bbox
    scaleBoundaries = clampPair(dialX1, dialX2, imageWidth)
    if (scaleBoundaries === null) {
      logger.warn(`boundary-detection — rejected implausible dial bbox [${dialX1},${dialX2}] for image width ${imageWidth}`)
    }
  } else {
    scaleBoundaries = null
  }

  return { ok: true, spliceBoundaries: caseBoundary, scaleBoundaries, confidence: null }
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
export async function detectBoundaries(
  imagePath: string,
  measureBy: string,
  endpointOverride?: string | null,
): Promise<BoundaryDetectResult> {
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

  return mapSegmentationResponse(parsed, imageWidth, measureBy)
}
