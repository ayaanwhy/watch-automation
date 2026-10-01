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
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { logger } from '../logger'
import { MIN_GUIDE_SEPARATION } from '../../src/types/annotation'
import type { BoundaryDetectResult, BoundaryPredictionPair, DetectionFailureReason } from '../../src/types/ipc'
import { SingleFlightQueue } from './singleFlightQueue'

const DEFAULT_ENDPOINT = 'https://watchdialcoord.clouddeploy.in'
// 2026-09-30 diagnostic fix — a direct probe against this same endpoint
// (sampledata/1688KM11.png, the real successful case below) measured ~6.6s
// end-to-end. The previous 10s budget left only ~3.4s of margin above that
// observed real latency for a SINGLE attempt, which is tight enough that an
// ordinarily-slow-but-healthy response could be misclassified as a timeout.
// 20s keeps roughly 3x headroom above the observed real latency while still
// failing a genuinely hung connection (TLS handshake completes, then no
// response at all — reproduced live 2026-09-29/30 during a real outage)
// well within a user-tolerable wait, especially combined with the one
// automatic retry below.
const REQUEST_TIMEOUT_MS = 20_000

// Phase 15.0 — the one authoritative arbiter for every boundary-detection
// request in this app, module-level so it's shared by every caller
// regardless of process boundary crossed to get here: Legacy's
// boundary:detect IPC handler calls detectBoundaries() below, and Sandbox's
// headless Watch runner (main-process, no IPC round-trip needed since it's
// already in this process) calls the exact same exported function — both
// funnel through this one queue. See singleFlightQueue.ts's own doc comment
// for why the earlier, renderer-only fix (AnnotationContext.tsx) wasn't
// sufficient once a non-renderer caller exists.
const detectionQueue = new SingleFlightQueue()

// Structured failure classification for callers that need to react to WHY a
// detection failed (the automation engine's error model) without ever
// inspecting the free-text `error`/`message` strings. Originally (Phase
// 15.0) a side channel keyed by the result object itself, kept unchanged for
// Sandbox's existing consumer (sandboxEditingPipeline.ts's
// watchDetectionFailure) — DetectionFailureReason itself now lives in
// types/ipc.ts (see that file) since BoundaryDetectResult's `code` field
// (2026-09-30) carries the same value directly, renderer-visible.
export interface DetectionFailureInfo {
  reason: DetectionFailureReason
  httpStatus?: number
  attempts?: number
}

const failureInfo = new WeakMap<object, DetectionFailureInfo>()

// Builds a fully-populated failure result (every field BoundaryDetectResult's
// false branch declares) and records the same reason/httpStatus/attempts in
// the WeakMap side channel by object identity, for Sandbox's unchanged
// consumer. `technicalMessage` is the ONE place raw/internal detail belongs
// (a stderr tail, the service's own free-text `message`, an HTTP body
// excerpt, an exception's own message) — never `error`, which stays the
// short, safe-to-show-by-default string it always was.
function failed(p: {
  reason: DetectionFailureReason
  error: string
  retryable: boolean
  technicalMessage: string
  httpStatus?: number
  attempts?: number
  endpoint?: string
  durationMs?: number
  cause?: string
  requestId?: string
}): Extract<BoundaryDetectResult, { ok: false }> {
  const result: Extract<BoundaryDetectResult, { ok: false }> = {
    ok: false,
    error: p.error,
    retryable: p.retryable,
    code: p.reason,
    technicalMessage: p.technicalMessage,
    ...(p.httpStatus !== undefined ? { httpStatus: p.httpStatus } : {}),
    ...(p.attempts !== undefined ? { attempts: p.attempts } : {}),
    ...(p.endpoint !== undefined ? { endpoint: p.endpoint } : {}),
    ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
    ...(p.cause !== undefined ? { cause: p.cause } : {}),
    ...(p.requestId !== undefined ? { requestId: p.requestId } : {}),
  }
  failureInfo.set(result, { reason: p.reason, httpStatus: p.httpStatus, attempts: p.attempts })
  return result
}

export function getDetectionFailureInfo(result: BoundaryDetectResult): DetectionFailureInfo | null {
  return result.ok ? null : (failureInfo.get(result) ?? null)
}

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
    // The API's own `message` is free text (sometimes a raw internal
    // exception — see the module header) and is never shown as the primary
    // `error`, but it's exactly the kind of detail technicalMessage exists
    // for — visible in the UI's Details expander, not swallowed.
    return failed({
      reason: 'no_detection',
      error: 'No boundaries detected for this image.',
      retryable: false,
      technicalMessage: `API response: success=${parsed.success}, case_bbox=${JSON.stringify(parsed.case_bbox)}${parsed.message ? ` — "${parsed.message}"` : ''}`,
    })
  }

  const [caseX1, , caseX2] = parsed.case_bbox
  const caseBoundary = clampPair(caseX1, caseX2, imageWidth)
  if (caseBoundary === null) {
    logger.warn(`boundary-detection — rejected implausible case bbox [${caseX1},${caseX2}] for image width ${imageWidth}`)
    return failed({
      reason: 'implausible',
      error: 'Detected boundaries were implausible.',
      retryable: false,
      technicalMessage: `Rejected case bbox [${caseX1}, ${caseX2}] for image width ${imageWidth} (clamped width below the minimum guide separation).`,
    })
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

// Public entry point — every caller goes through the single-flight queue,
// never calls detectBoundariesOnce directly. The queue guarantees this
// specific call won't overlap any other in-flight detection request,
// app-wide, regardless of which caller (Legacy IPC, Sandbox headless
// runner) enqueued it or in what order.
export function detectBoundaries(
  imagePath: string,
  measureBy: string,
  endpointOverride?: string | null,
  // Caller-supplied correlation id (2026-09-30) — opaque here, just logged
  // and echoed back on the result; see BoundaryDetectPayload's own comment.
  // Optional and additive: Sandbox's existing callers pass nothing and are
  // unaffected.
  requestId?: string,
): Promise<BoundaryDetectResult> {
  return detectionQueue.run(() => detectBoundariesOnce(imagePath, measureBy, endpointOverride, requestId))
}

// Two transparent retry rules, both inside the single-flight lane (so a retry
// is always sequential — never concurrent with any other request):
//   1. a network-level failure (connection error, timeout) is retried once,
//      inside detectAttempt;
//   2. an HTTP-200 `success:false` with no case_bbox ("no_detection") is
//      retried once, here. Diagnosis (2026-09-30): the Watch API's backend
//      returns exactly that shape — with a gRPC "UNAVAILABLE ... Connection
//      timed out" message — for the first request after it has been idle
//      ~6+ minutes (a stale API->model-service connection), and an immediate
//      second request always succeeds. The message text is deliberately NOT
//      inspected (free text, see the module header): a genuine non-detection
//      simply repeats and costs one extra call. The retry is a full second
//      attempt at the same request, so `attempts` on the final result counts
//      every HTTP request made.
// This is distinct from 14C's later user-facing Retry button (a fresh,
// user-initiated call).
async function detectBoundariesOnce(
  imagePath: string,
  measureBy: string,
  endpointOverride?: string | null,
  requestId?: string,
): Promise<BoundaryDetectResult> {
  const t0 = Date.now()
  const tag = requestId ? `[${requestId}] ` : ''
  const first = await detectAttempt(imagePath, measureBy, endpointOverride, requestId)
  if (first.ok || first.code !== 'no_detection') return first

  logger.warn(`${tag}boundary-detection — success:false / no case_bbox on attempt ${first.attempts ?? 1}; retrying once (${first.technicalMessage})`)
  const second = await detectAttempt(imagePath, measureBy, endpointOverride, requestId)
  if (second.ok) {
    logger.info(`${tag}boundary-detection — retry recovered the detection after ${Date.now() - t0}ms total`)
    return second
  }
  const totalAttempts = (first.attempts ?? 1) + (second.attempts ?? 1)
  second.attempts = totalAttempts
  second.durationMs = Date.now() - t0
  second.technicalMessage = `${second.technicalMessage} | first attempt: ${first.technicalMessage}`
  failureInfo.set(second, { reason: second.code, httpStatus: second.httpStatus, attempts: totalAttempts })
  logger.warn(`${tag}boundary-detection — both attempts failed (${totalAttempts} requests, ${second.durationMs}ms total)`)
  return second
}

async function detectAttempt(
  imagePath: string,
  measureBy: string,
  endpointOverride?: string | null,
  requestId?: string,
): Promise<BoundaryDetectResult> {
  const endpoint = (endpointOverride?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '')
  const t0 = Date.now()
  const elapsed = () => Date.now() - t0
  const tag = requestId ? `[${requestId}] ` : ''

  let imageBuffer: Buffer
  let imageWidth: number
  let imageInfo = ''
  try {
    imageBuffer = await readFile(imagePath)
    const metadata = await sharp(imageBuffer).metadata()
    if (!metadata.width) throw new Error('image has no readable width')
    imageWidth = metadata.width
    imageInfo = `${imageBuffer.length} bytes, ${metadata.format} ${metadata.width}x${metadata.height}, sha256=${createHash('sha256').update(imageBuffer).digest('hex').slice(0, 16)}`
  } catch (err) {
    logger.warn(`${tag}boundary-detection — failed to read image ${imagePath}`, err)
    return failed({
      reason: 'image_unreadable',
      error: 'Could not read the image file for detection.',
      retryable: false,
      technicalMessage: err instanceof Error ? err.message : String(err),
      endpoint,
      durationMs: elapsed(),
      attempts: 0,
      requestId,
    })
  }

  logger.info(`${tag}boundary-detection — POST ${endpoint}/bbox/predict (${imagePath.split(/[\\/]/).pop()}; ${imageInfo}; sent as multipart field 'image', no explicit MIME)`)

  let response: Response | null = null
  let lastNetworkError: unknown = null
  let attempts = 0
  for (; attempts < 2 && response === null; attempts++) {
    try {
      response = await postPredict(endpoint, imageBuffer)
    } catch (err) {
      lastNetworkError = err
      logger.warn(`${tag}boundary-detection — attempt ${attempts + 1}/2 to ${endpoint} failed after ${elapsed()}ms`, err)
    }
  }

  if (response === null) {
    const aborted = lastNetworkError instanceof Error && lastNetworkError.name === 'AbortError'
    const cause = lastNetworkError instanceof Error ? `${lastNetworkError.name}: ${lastNetworkError.message}` : String(lastNetworkError)
    logger.warn(`${tag}boundary-detection — request to ${endpoint} failed after ${attempts} attempt(s) in ${elapsed()}ms (${aborted ? 'timeout' : 'network'})`, lastNetworkError)
    return failed({
      reason: aborted ? 'timeout' : 'network',
      error: aborted ? 'Detection request timed out.' : 'Could not reach the detection service.',
      retryable: true,
      technicalMessage: aborted
        ? `No response within ${REQUEST_TIMEOUT_MS}ms per attempt (${attempts} attempt(s), ${elapsed()}ms total).`
        : `Network request failed (${attempts} attempt(s), ${elapsed()}ms total).`,
      endpoint,
      durationMs: elapsed(),
      attempts,
      cause,
      requestId,
    })
  }

  logger.info(`${tag}boundary-detection — HTTP ${response.status} from ${endpoint} in ${elapsed()}ms (attempt ${attempts}/2)`)

  if (!response.ok) {
    let bodyExcerpt = ''
    try {
      bodyExcerpt = (await response.text()).slice(0, 500)
    } catch {
      // best-effort diagnostic only — the failure itself is reported either way
    }
    logger.warn(`${tag}boundary-detection — HTTP ${response.status} from ${endpoint}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`)
    return failed({
      reason: 'http_error',
      error: `Detection service returned an error (HTTP ${response.status}).`,
      retryable: true,
      technicalMessage: `HTTP ${response.status} ${response.statusText}${bodyExcerpt ? ` — ${bodyExcerpt}` : ''}`,
      httpStatus: response.status,
      endpoint,
      durationMs: elapsed(),
      attempts,
      requestId,
    })
  }

  let rawText = ''
  let parsed: SegmentationResponse
  try {
    rawText = await response.clone().text()
    parsed = JSON.parse(rawText)
  } catch (err) {
    logger.warn(`${tag}boundary-detection — response from ${endpoint} was not valid JSON`, err, { rawText: rawText.slice(0, 500) })
    return failed({
      reason: 'malformed_response',
      error: 'Detection service returned an unreadable response.',
      retryable: true,
      technicalMessage: `${err instanceof Error ? err.message : String(err)}${rawText ? ` — body: ${rawText.slice(0, 500)}` : ''}`,
      endpoint,
      durationMs: elapsed(),
      attempts,
      requestId,
    })
  }

  const mapped = mapSegmentationResponse(parsed, imageWidth, measureBy)
  // mapSegmentationResponse is pure (no network context of its own) — fill
  // in the request-level diagnostics it can't know about itself, mutating
  // in place so the WeakMap entry `failed()` already attached (keyed by
  // object identity, for Sandbox's getDetectionFailureInfo) stays valid.
  if (!mapped.ok) {
    mapped.endpoint = endpoint
    mapped.durationMs = elapsed()
    mapped.attempts = attempts
    mapped.requestId = requestId
  } else {
    mapped.requestId = requestId
  }
  logger.info(`${tag}boundary-detection — resolved ${mapped.ok ? 'ok' : `failed (${mapped.code})`} in ${elapsed()}ms`)
  return mapped
}
