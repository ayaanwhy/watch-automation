import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { MIN_GUIDE_SEPARATION, resolveProvenance } from '../types/annotation'
import type { AnnotationStatus, BatchState, BoundaryData, BoundaryPrediction, GuideMode, WatchAnnotation } from '../types/annotation'
import type { BoundaryPredictionPair, SpreadsheetRowData } from '../types/ipc'
import type { SessionFile } from '../types/session'

type SimpleBoundary = { leftBoundary: number; rightBoundary: number }

// Per-SKU AI detection lifecycle (Phase 14C). 'idle' is never stored in the
// map (absence of an entry means idle) — it exists only as the value
// consumers see for a SKU that hasn't been touched yet.
export type DetectionStatus = 'idle' | 'pending' | 'success' | 'failed'

// No Node.js path module in the renderer — mirrors AnnotationWorkspace.tsx's
// own local copy exactly (see that file's comment: kept local rather than
// importing lib/paths.ts, to avoid touching Watch Processing files outside
// whatever milestone introduced it). Needed here too since detection fetches
// are now triggered from this context, not just from the workspace screen.
function joinPath(dir: string, file: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + file
  return dir.includes('\\') ? `${dir}\\${file}` : `${dir}/${file}`
}

interface AnnotationContextValue {
  batch: BatchState
  annotations: WatchAnnotation[]
  currentIndex: number
  mode: GuideMode
  currentAnnotation: WatchAnnotation
  currentRow: SpreadsheetRowData
  annotatedCount: number
  submitAnnotation(
    splice: SimpleBoundary,
    scale: SimpleBoundary | null
  ): { safeSplice: BoundaryData; safeScale: BoundaryData | null }
  navigate(delta: -1 | 1): void
  jumpTo(index: number): void
  setMode(mode: GuideMode): void
  // AI boundary detection (Phase 14C) — the API-specific mapping
  // (BoundaryDetectResult, case_bbox/dial_bbox, etc.) stays entirely inside
  // boundaryDetection.ts/the boundary:detect IPC call; nothing here or in
  // any consumer (AnnotationWorkspace, AnnotationCanvas, InfoPanel) ever
  // sees that shape — only these already-resolved, editing-model-native
  // values.
  aiDetectionEnabled: boolean
  // True only while a prediction for the CURRENT SKU is genuinely still
  // outstanding (not yet requested, or in flight) — AnnotationCanvas's
  // holdGuides prop keys off this directly so guides never initialize to
  // their default position and then jump once a prediction arrives.
  holdGuides: boolean
  currentDetectionStatus: DetectionStatus
  // {leftBoundary, rightBoundary} | null — not the full BoundaryData shape,
  // since a live prediction has no meaningful source/confidence-for-display
  // yet (that's resolved only once submitted). AnnotationCanvas's
  // savedSpliceBoundaries/savedScaleBoundaries props only ever read the two
  // numbers, so this satisfies them directly with no wrapper object.
  currentSplicePrediction: BoundaryPredictionPair | null
  currentScalePrediction: BoundaryPredictionPair | null
  circuitBroken: boolean
  // Re-requests a detection for the current SKU, ignoring any cached
  // failure — the one user-initiated retry path, distinct from
  // detectBoundaries' own internal one-shot network retry. Resets the
  // circuit breaker on success.
  retryDetection(): void
}

const AnnotationContext = createContext<AnnotationContextValue | null>(null)

export function useAnnotation(): AnnotationContextValue {
  const ctx = useContext(AnnotationContext)
  if (!ctx) throw new Error('useAnnotation must be used within AnnotationProvider')
  return ctx
}

interface AnnotationProviderProps {
  batch: BatchState
  initialSession?: SessionFile | null
  children: ReactNode
}

// prediction: the live AI prediction shown for this boundary pair, if any
// (Phase 14C) — null for every caller until a detection succeeds, which
// resolveProvenance already treats as 'manual'/null (bit-identical to the
// pre-14C hardcoded stamp). See resolveProvenance's own doc comment.
// Exported (not just used internally by submitAnnotation) so its rounding +
// clamping + provenance-resolution combination is directly unit-testable
// without rendering the React context.
export function clampBoundary(b: SimpleBoundary, prediction: BoundaryPrediction | null): BoundaryData {
  const safeLeft = Math.round(Math.min(b.leftBoundary, b.rightBoundary - MIN_GUIDE_SEPARATION))
  const safeRight = Math.round(Math.max(b.rightBoundary, b.leftBoundary + MIN_GUIDE_SEPARATION))
  const { source, confidence } = resolveProvenance({ leftBoundary: safeLeft, rightBoundary: safeRight }, prediction)
  return { leftBoundary: safeLeft, rightBoundary: safeRight, source, confidence }
}

// Circuit breaker threshold (Phase 14C) — 3 consecutive detection failures
// anywhere in the batch stop further auto-detection for its remainder;
// per-SKU manual Retry still works and resets this on success.
const CIRCUIT_BREAKER_THRESHOLD = 3

// Absolute single-flight guarantee (2026-09-18) — a minimal, dependency-free
// FIFO that runs at most one async job at a time, queuing (de-duped by key)
// anything requested while busy rather than dropping or overlapping it.
// isPrefetchEligible below keeps the trigger and prefetch effects from
// overlapping in the common case, but doesn't cover every caller — a forced
// manual Retry, or a direct jump to an arbitrary SKU while an unrelated
// SKU's prefetch is still in flight, could otherwise still start a second
// concurrent boundary:detect call. Every caller (trigger, prefetch, and
// retry alike) now goes through one instance of this queue instead, so
// there is exactly one place, not three, responsible for "never two at
// once." Extracted as a standalone class (not left inline in the provider)
// so this specific guarantee is directly unit-testable with a fake runner —
// this test setup has no jsdom/testing-library to render the real effect
// tree and observe actual network overlap.
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

  enqueue(key: K, force = false): void {
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
    if (this.inFlightKey !== null) return // something's already running — it drains the next entry itself when it finishes
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

// Serialization guard (2026-09-18 diagnostic fix) — true once there is
// nothing left to wait for on the current SKU's own detection: either it
// was never needed (detection disabled, already annotated, or already has
// saved boundaries), or it genuinely settled (success or failed). The
// prefetch effect gates on this so it can never start while the current
// SKU's own boundary:detect call is still in flight.
//
// Before this fix, the prefetch effect fired unconditionally alongside the
// trigger effect, so opening a fresh Automatic batch dispatched two
// /bbox/predict requests within milliseconds of each other. The live
// watchdialcoord.clouddeploy.in service cannot tolerate concurrent
// requests — two at once reliably hung the entire service (reproduced
// directly; see IMPLEMENTATION_PLAN.md's Phase 14 diagnostic, 2026-09-18).
//
// Extracted as a pure function (not left inline in the component) so this
// specific guard is directly unit-testable — this test setup has no
// jsdom/testing-library, so the effects themselves can't be rendered and
// observed directly.
export function isPrefetchEligible(params: {
  aiDetectionEnabled: boolean
  currentStatus: AnnotationStatus
  currentSpliceBoundaries: BoundaryData | null
  currentDetectionStatus: DetectionStatus
}): boolean {
  if (!params.aiDetectionEnabled) return true
  if (params.currentStatus !== 'unannotated') return true
  if (params.currentSpliceBoundaries !== null) return true
  return params.currentDetectionStatus === 'success' || params.currentDetectionStatus === 'failed'
}

export function AnnotationProvider({ batch, initialSession, children }: AnnotationProviderProps) {
  const [annotations, setAnnotations] = useState<WatchAnnotation[]>(() => {
    const saved = new Map(
      (initialSession?.annotations ?? []).map(a => [a.sku, a])
    )
    return batch.match.matched.map(sku => {
      const s = saved.get(sku)
      if (s) {
        return {
          sku: s.sku,
          status: s.status,
          spliceBoundaries: s.spliceBoundaries,
          scaleBoundaries: s.scaleBoundaries,
        }
      }
      return { sku, status: 'unannotated' as const, spliceBoundaries: null, scaleBoundaries: null }
    })
  })

  const [currentIndex, setCurrentIndex] = useState(() => {
    if (!initialSession) return 0
    return Math.min(initialSession.currentIndex, batch.match.matched.length - 1)
  })

  const [mode, setMode] = useState<GuideMode>(() => initialSession?.guideMode ?? 'uniform')

  const total = annotations.length
  const currentAnnotation = annotations[currentIndex]
  const currentRow = batch.match.rows[currentAnnotation.sku]
  const annotatedCount = annotations.filter(a => a.status === 'annotated').length

  // ── AI boundary detection (Phase 14C) ─────────────────────────────────
  const aiDetectionEnabled = batch.processingMode === 'automatic'
  const [predictions, setPredictions] = useState<Map<string, { spliceBoundaries: BoundaryPredictionPair | null; scaleBoundaries: BoundaryPredictionPair | null; confidence: number | null }>>(new Map())
  const [detectionStatusMap, setDetectionStatusMap] = useState<Map<string, DetectionStatus>>(new Map())
  const [circuitBroken, setCircuitBroken] = useState(false)
  // predictedRef mirrors the "do we already have a result" state
  // synchronously, since enqueueDetection is called from effects that fire
  // in quick succession and a closure over stale React state would
  // needlessly re-queue a SKU that's already resolved.
  const predictedRef = useRef<Set<string>>(new Set())
  const consecutiveFailuresRef = useRef(0)
  // One SingleFlightQueue instance per provider, stable across renders —
  // its runner closure below still reaches current component state via the
  // normal render-scoped closures (batch, setDetectionStatusMap, etc.),
  // same as the rest of this file; only the "run one at a time, queue the
  // rest" bookkeeping is factored out.
  const detectionQueueRef = useRef<SingleFlightQueue<string> | null>(null)
  if (detectionQueueRef.current === null) {
    detectionQueueRef.current = new SingleFlightQueue<string>(
      (sku, force) => runDetectionOnce(sku, force),
      sku => predictedRef.current.has(sku),
    )
  }

  function enqueueDetection(sku: string, force = false) {
    detectionQueueRef.current!.enqueue(sku, force)
  }

  async function runDetectionOnce(sku: string, force: boolean) {
    if (!force && predictedRef.current.has(sku)) return
    const row = batch.match.rows[sku]
    if (!row) return

    setDetectionStatusMap(prev => new Map(prev).set(sku, 'pending'))

    const imagePath = joinPath(batch.inputFolder, `${sku}.png`)
    const result = await window.api.invoke('boundary:detect', { imagePath, measureBy: row.measureBy })

    predictedRef.current.add(sku)

    if (result.ok) {
      consecutiveFailuresRef.current = 0
      setCircuitBroken(false)
      setPredictions(prev =>
        new Map(prev).set(sku, {
          spliceBoundaries: result.spliceBoundaries,
          scaleBoundaries: result.scaleBoundaries,
          confidence: result.confidence,
        }),
      )
      setDetectionStatusMap(prev => new Map(prev).set(sku, 'success'))
    } else {
      consecutiveFailuresRef.current += 1
      if (consecutiveFailuresRef.current >= CIRCUIT_BREAKER_THRESHOLD) setCircuitBroken(true)
      setDetectionStatusMap(prev => new Map(prev).set(sku, 'failed'))
    }
  }

  const currentPrediction = predictions.get(currentAnnotation.sku) ?? null
  const currentDetectionStatus: DetectionStatus = detectionStatusMap.get(currentAnnotation.sku) ?? 'idle'
  const currentDetectionSettledOrNotNeeded = isPrefetchEligible({
    aiDetectionEnabled,
    currentStatus: currentAnnotation.status,
    currentSpliceBoundaries: currentAnnotation.spliceBoundaries,
    currentDetectionStatus,
  })

  // Trigger: only for the current annotation, only when it's genuinely
  // unannotated with no saved boundaries — matches the Phase 14 design's
  // "Manual mode makes ZERO API calls" and "only for unannotated SKUs"
  // rules exactly.
  useEffect(() => {
    if (!aiDetectionEnabled || circuitBroken) return
    if (currentAnnotation.status !== 'unannotated' || currentAnnotation.spliceBoundaries !== null) return
    enqueueDetection(currentAnnotation.sku)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDetectionEnabled, circuitBroken, currentAnnotation.sku])

  // Prefetch: the next unannotated SKU's prediction, while the operator is
  // still working on the current one — after the first image, the hold in
  // holdGuides is normally zero because this has already settled.
  //
  // Gated on currentDetectionSettledOrNotNeeded (post-2026-09-18 diagnostic
  // fix) — this effect used to fire unconditionally alongside the trigger
  // effect above, so on opening a fresh Automatic batch both ran in the same
  // React commit and dispatched two /bbox/predict requests within
  // milliseconds of each other. The live watchdialcoord.clouddeploy.in
  // service cannot tolerate concurrent requests: two at once reliably hung
  // the entire service (reproduced directly, see IMPLEMENTATION_PLAN.md's
  // Phase 14 diagnostic). Waiting for the current SKU to settle first
  // guarantees this app never has two boundary:detect calls in flight at
  // once, while still prefetching — just serialized, one request at a time,
  // rather than removed. The re-check happens automatically: this effect's
  // own dependency array includes currentDetectionSettledOrNotNeeded, so it
  // re-runs the instant the current SKU's detection settles.
  useEffect(() => {
    if (!aiDetectionEnabled || circuitBroken) return
    if (!currentDetectionSettledOrNotNeeded) return
    const next = annotations[currentIndex + 1]
    if (!next || next.status !== 'unannotated' || next.spliceBoundaries !== null) return
    enqueueDetection(next.sku)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDetectionEnabled, circuitBroken, currentIndex, currentDetectionSettledOrNotNeeded])

  // force:true — re-requests even though predictedRef already has a
  // (failed) result for this SKU. Still goes through the same queue as
  // every other caller (2026-09-18): if a prefetch for a different SKU
  // happens to be in flight, this waits for it rather than running
  // alongside it — the absolute never-concurrent guarantee applies to
  // Retry too, not just the trigger/prefetch pair.
  function retryDetection() {
    enqueueDetection(currentAnnotation.sku, true)
  }
  // Held exactly while a prediction for the CURRENT sku could still arrive
  // and change the guides' initial position — i.e. the same gate the
  // trigger effect uses, so AnnotationCanvas never initializes to the
  // 20%/80% default only to have it overwritten a moment later.
  const holdGuides =
    aiDetectionEnabled &&
    !circuitBroken &&
    currentAnnotation.status === 'unannotated' &&
    currentAnnotation.spliceBoundaries === null &&
    currentDetectionStatus !== 'success' &&
    currentDetectionStatus !== 'failed'

  function submitAnnotation(
    splice: SimpleBoundary,
    scale: SimpleBoundary | null
  ): { safeSplice: BoundaryData; safeScale: BoundaryData | null } {
    const prediction = currentPrediction
    const splicePrediction: BoundaryPrediction | null = prediction?.spliceBoundaries
      ? { ...prediction.spliceBoundaries, confidence: prediction.confidence }
      : null
    const scalePrediction: BoundaryPrediction | null = prediction?.scaleBoundaries
      ? { ...prediction.scaleBoundaries, confidence: prediction.confidence }
      : null

    const safeSplice = clampBoundary(splice, splicePrediction)
    const safeScale = scale ? clampBoundary(scale, scalePrediction) : null

    setAnnotations(prev =>
      prev.map((a, i) =>
        i === currentIndex
          ? { ...a, status: 'annotated', spliceBoundaries: safeSplice, scaleBoundaries: safeScale }
          : a
      )
    )
    setCurrentIndex(prev => Math.min(prev + 1, total - 1))
    return { safeSplice, safeScale }
  }

  function navigate(delta: -1 | 1) {
    setCurrentIndex(prev => Math.max(0, Math.min(prev + delta, total - 1)))
  }

  function jumpTo(index: number): void {
    setCurrentIndex(Math.max(0, Math.min(index, total - 1)))
  }

  const value: AnnotationContextValue = {
    batch,
    annotations,
    currentIndex,
    mode,
    currentAnnotation,
    currentRow,
    annotatedCount,
    submitAnnotation,
    navigate,
    jumpTo,
    setMode,
    aiDetectionEnabled,
    holdGuides,
    currentDetectionStatus,
    currentSplicePrediction: currentPrediction?.spliceBoundaries ?? null,
    currentScalePrediction: currentPrediction?.scaleBoundaries ?? null,
    circuitBroken,
    retryDetection,
  }

  return <AnnotationContext.Provider value={value}>{children}</AnnotationContext.Provider>
}
