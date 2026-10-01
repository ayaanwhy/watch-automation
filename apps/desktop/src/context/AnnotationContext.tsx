import { createContext, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { MIN_GUIDE_SEPARATION, resolveProvenance } from '../types/annotation'
import type { AnnotationStatus, BatchState, BoundaryData, BoundaryPrediction, GuideMode, WatchAnnotation } from '../types/annotation'
import type { BoundaryDetectResult, BoundaryPredictionPair, SpreadsheetRowData } from '../types/ipc'
import type { SessionFile } from '../types/session'
import { DetectionController, nextCircuitRetryDelayMs, type DetectionFailure, type DetectionStatus } from './detectionController'

// The detection state machine (queue, per-sku maps, request ids, circuit
// breaker) lives in detectionController.ts so it is testable without React;
// these re-exports keep every existing import path working.
export { SingleFlightQueue, shouldTripCircuitBreaker, nextCircuitRetryDelayMs } from './detectionController'
export type { DetectionFailure, DetectionStatus } from './detectionController'

type SimpleBoundary = { leftBoundary: number; rightBoundary: number }

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
  // The structured failure for the CURRENT sku's most recent detection
  // attempt — null while idle/pending/succeeded. Distinct from
  // currentDetectionStatus === 'failed': that's the UI-facing boolean-ish
  // state; this is WHY, for a Details/debug path (2026-09-30).
  currentDetectionError: DetectionFailure | null
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
  // All detection state lives in one DetectionController (see
  // detectionController.ts for the queue/request-id/circuit-breaker rules);
  // this provider only mirrors it into React (re-render on change) and feeds
  // it the current batch through `invokeRef` — a ref refreshed every render,
  // so the controller never holds a stale render's `batch`.
  const aiDetectionEnabled = batch.processingMode === 'automatic'
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const invokeRef = useRef<(sku: string, requestId: string) => Promise<BoundaryDetectResult | null>>(async () => null)
  invokeRef.current = async (sku, requestId) => {
    const row = batch.match.rows[sku]
    if (!row) return null
    const imagePath = joinPath(batch.inputFolder, `${sku}.png`)
    return window.api.invoke('boundary:detect', { imagePath, measureBy: row.measureBy, requestId })
  }
  const controllerRef = useRef<DetectionController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = new DetectionController({
      invoke: (sku, requestId) => invokeRef.current(sku, requestId),
      onChange: () => rerender(),
    })
  }
  const detection = controllerRef.current
  const circuitBroken = detection.circuitBroken

  const currentPrediction = detection.predictionOf(currentAnnotation.sku)
  const currentDetectionStatus: DetectionStatus = detection.statusOf(currentAnnotation.sku)
  const currentDetectionError = detection.errorOf(currentAnnotation.sku)
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
    if (!aiDetectionEnabled) return
    if (currentAnnotation.status !== 'unannotated' || currentAnnotation.spliceBoundaries !== null) return
    // Selection ALWAYS reaches the controller, even with the breaker open:
    // the controller decides (probe vs. queue) — a tripped breaker must not
    // silently swallow every later sku.
    detection.select(currentAnnotation.sku)
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
    detection.prefetch(next.sku)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDetectionEnabled, circuitBroken, currentIndex, currentDetectionSettledOrNotNeeded])

  // Kept in sync so the auto-recovery loop below always retries whichever
  // sku is CURRENTLY on screen, not whichever one was current when the
  // breaker first tripped.
  const currentSkuRef = useRef(currentAnnotation.sku)
  useEffect(() => {
    currentSkuRef.current = currentAnnotation.sku
  }, [currentAnnotation.sku])

  // Circuit-breaker auto-recovery (2026-09-30) — see nextCircuitRetryDelayMs's
  // own comment for why this exists. A plain `useEffect` keyed on
  // `circuitBroken` alone would only fire once (true stays true across a
  // failed auto-retry, so the effect's own dependency never changes again);
  // this schedules its own recurring timer instead, stopping itself once the
  // breaker clears (checked at each tick, not just at effect-start) or the
  // provider unmounts/batch changes.
  useEffect(() => {
    if (!aiDetectionEnabled || !circuitBroken) return
    let cancelled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      if (cancelled) return
      detection.retry(currentSkuRef.current)
      attempt += 1
      timer = setTimeout(tick, nextCircuitRetryDelayMs(attempt))
    }
    timer = setTimeout(tick, nextCircuitRetryDelayMs(0))
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDetectionEnabled, circuitBroken])

  // force:true — re-requests even though predictedRef already has a
  // (failed) result for this SKU. Still goes through the same queue as
  // every other caller (2026-09-18): if a prefetch for a different SKU
  // happens to be in flight, this waits for it rather than running
  // alongside it — the absolute never-concurrent guarantee applies to
  // Retry too, not just the trigger/prefetch pair.
  function retryDetection() {
    detection.retry(currentAnnotation.sku)
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
    currentDetectionError,
    circuitBroken,
    retryDetection,
  }

  return <AnnotationContext.Provider value={value}>{children}</AnnotationContext.Provider>
}
