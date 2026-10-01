// Core/Legacy Watch AI detection state machine, extracted from
// AnnotationContext.tsx (2026-09-30) so it can be tested — and driven with a
// real detection backend — without rendering React (this repo has no
// jsdom/testing-library). AnnotationContext owns exactly one controller per
// provider and mirrors its state into React; every rule below is the same one
// the component previously held inline, plus the cross-SKU fixes documented
// on `select()`.
import type { BoundaryDetectResult, BoundaryPredictionPair } from '../types/ipc'

export type DetectionFailure = Extract<BoundaryDetectResult, { ok: false }>
export type DetectionStatus = 'idle' | 'pending' | 'success' | 'failed'

// Which AI Detection badge a sku shows. The sku's OWN state wins: a sku whose
// detection succeeded (or is in flight) must never show the global "AI
// detection unavailable" just because the breaker is open for other skus.
// The breaker message only applies to a sku that has no successful result.
export type DetectionBadge = 'success' | 'detecting' | 'unavailable' | 'failed'
export function detectionBadge(status: DetectionStatus, circuitBroken: boolean): DetectionBadge {
  if (status === 'success') return 'success'
  if (status === 'pending') return 'detecting'
  if (status === 'failed') return circuitBroken ? 'unavailable' : 'failed'
  return circuitBroken ? 'unavailable' : 'detecting' // idle
}

export interface StoredPrediction {
  spliceBoundaries: BoundaryPredictionPair | null
  scaleBoundaries: BoundaryPredictionPair | null
  confidence: number | null
}

// Circuit breaker threshold (Phase 14C) — 3 consecutive detection failures.
const CIRCUIT_BREAKER_THRESHOLD = 3
export function shouldTripCircuitBreaker(consecutiveFailures: number): boolean {
  return consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD
}

// Circuit-breaker auto-recovery backoff — see AnnotationContext history.
const CIRCUIT_RETRY_BASE_MS = 15_000
const CIRCUIT_RETRY_MAX_MS = 120_000
export function nextCircuitRetryDelayMs(attempt: number): number {
  return Math.min(CIRCUIT_RETRY_BASE_MS * 2 ** Math.max(0, attempt), CIRCUIT_RETRY_MAX_MS)
}

// Absolute single-flight guarantee (2026-09-18): at most one async job runs
// at a time, and — since 2026-09-30 — at most one request per KEY is
// outstanding (in flight or queued). See enqueue().
export class SingleFlightQueue<K> {
  private inFlightKey: K | null = null
  private queue: { key: K; force: boolean }[] = []

  constructor(
    private readonly runner: (key: K, force: boolean) => Promise<void>,
    private readonly hasResult: (key: K) => boolean,
  ) {}

  get currentlyInFlight(): K | null {
    return this.inFlightKey
  }

  get isBusy(): boolean {
    return this.inFlightKey !== null || this.queue.length > 0
  }

  // A key already in flight is authoritative: any further request for it,
  // forced or not, is redundant and dropped (its own result is exactly what a
  // fresh request would obtain). Without this, a duplicate queued behind the
  // in-flight run could fail AFTER the first succeeded and overwrite its
  // success (the "AI detection failed although the API answered" race).
  enqueue(key: K, force = false): void {
    if (key === this.inFlightKey) return
    if (!force && this.hasResult(key)) return
    const existing = this.queue.find(q => q.key === key)
    if (existing) {
      existing.force = existing.force || force
    } else {
      this.queue.push({ key, force })
    }
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.inFlightKey !== null) return
    const next = this.queue.shift()
    if (!next) return
    this.inFlightKey = next.key
    try {
      await this.runner(next.key, next.force)
    } finally {
      this.inFlightKey = null
    }
    void this.drain()
  }
}

export type DetectionTraceEvent =
  | { type: 'request'; sku: string; requestId: string; force: boolean }
  | { type: 'response'; sku: string; requestId: string; ok: boolean; code?: string }
  | { type: 'discarded-stale'; sku: string; requestId: string }
  | { type: 'skipped'; sku: string; reason: string }

export interface DetectionControllerOptions {
  // Performs ONE detection for `sku`; resolves null when there is nothing to
  // request (e.g. the sku has no spreadsheet row) — no request is recorded.
  invoke(sku: string, requestId: string): Promise<BoundaryDetectResult | null>
  // Called after any state change so the owner can re-render.
  onChange(): void
  onTrace?(event: DetectionTraceEvent): void
}

export class DetectionController {
  readonly predictions = new Map<string, StoredPrediction>()
  readonly statuses = new Map<string, DetectionStatus>()
  readonly errors = new Map<string, DetectionFailure>()
  circuitBroken = false
  consecutiveFailures = 0

  private readonly predicted = new Set<string>()
  private readonly latestRequestId = new Map<string, string>()
  private seq = 0
  private readonly queue: SingleFlightQueue<string>

  constructor(private readonly opts: DetectionControllerOptions) {
    this.queue = new SingleFlightQueue<string>((sku, force) => this.runOnce(sku, force), sku => this.predicted.has(sku))
  }

  statusOf(sku: string): DetectionStatus {
    return this.statuses.get(sku) ?? 'idle'
  }
  errorOf(sku: string): DetectionFailure | null {
    return this.errors.get(sku) ?? null
  }
  predictionOf(sku: string): StoredPrediction | null {
    return this.predictions.get(sku) ?? null
  }
  get inFlight(): string | null {
    return this.queue.currentlyInFlight
  }

  // The CURRENT sku became selected (and needs a prediction). While the
  // breaker is closed this is an ordinary request. While it is OPEN it used
  // to be a hard block — every later sku then showed "AI detection
  // unavailable" without any request ever being made for it, so one bad
  // stretch poisoned every image selected afterwards. Now an open breaker
  // still limits load (nothing else queues behind a probe) but never
  // prevents the newly selected sku from getting its own request: it is sent
  // as a single probe when nothing else is outstanding, and its success
  // closes the breaker.
  select(sku: string): void {
    if (this.circuitBroken) {
      if (this.queue.isBusy) {
        this.opts.onTrace?.({ type: 'skipped', sku, reason: 'circuit open and another request is outstanding' })
        return
      }
      this.queue.enqueue(sku) // no-op when this sku already has its own result
      return
    }
    this.queue.enqueue(sku)
  }

  // Look-ahead for the next sku; never while the breaker is open.
  prefetch(sku: string): void {
    if (this.circuitBroken) return
    this.queue.enqueue(sku)
  }

  // User Retry / circuit auto-recovery: always a fresh request.
  retry(sku: string): void {
    this.queue.enqueue(sku, true)
  }

  private async runOnce(sku: string, force: boolean): Promise<void> {
    if (!force && this.predicted.has(sku)) return

    const requestId = `${sku}#${++this.seq}`
    this.latestRequestId.set(sku, requestId)
    this.statuses.set(sku, 'pending')
    this.opts.onChange()
    this.opts.onTrace?.({ type: 'request', sku, requestId, force })

    let result: BoundaryDetectResult | null
    try {
      result = await this.opts.invoke(sku, requestId)
    } catch (err) {
      // An IPC-level crash must settle the sku (never leave it 'pending').
      result = {
        ok: false, error: 'Detection request failed.', retryable: true, code: 'network',
        technicalMessage: err instanceof Error ? err.message : String(err), requestId,
      }
    }
    if (result === null) {
      this.latestRequestId.delete(sku)
      this.statuses.delete(sku)
      this.opts.onChange()
      this.opts.onTrace?.({ type: 'skipped', sku, reason: 'nothing to request' })
      return
    }

    // Stale-response guard: a newer request for THIS sku has superseded ours.
    if (this.latestRequestId.get(sku) !== requestId) {
      this.opts.onTrace?.({ type: 'discarded-stale', sku, requestId })
      return
    }

    this.predicted.add(sku)
    this.opts.onTrace?.({ type: 'response', sku, requestId, ok: result.ok, code: result.ok ? undefined : result.code })

    if (result.ok) {
      this.consecutiveFailures = 0
      this.circuitBroken = false
      this.predictions.set(sku, { spliceBoundaries: result.spliceBoundaries, scaleBoundaries: result.scaleBoundaries, confidence: result.confidence })
      this.statuses.set(sku, 'success')
      this.errors.delete(sku)
    } else {
      this.consecutiveFailures += 1
      if (shouldTripCircuitBreaker(this.consecutiveFailures)) this.circuitBroken = true
      this.statuses.set(sku, 'failed')
      this.errors.set(sku, result)
    }
    this.opts.onChange()
  }
}
