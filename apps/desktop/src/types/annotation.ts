import type { MatchSummary } from './ipc'
import type { ProcessingMode } from '../constants/processingMode'

export const MIN_GUIDE_SEPARATION = 10

// 'ai-adjusted' widened in Phase 14A — an AI prediction the user then moved,
// tracked separately from an untouched 'ai' acceptance so the eventual
// accepted-vs-adjusted-vs-manual success metric (Phase 14D) is measurable.
// Deliberately NOT a SESSION_VERSION bump (types/session.ts) — widening a
// string union is runtime-invisible (no shape change, nothing validates the
// union at runtime), so existing v4 session files stay valid as-is.
export type BoundarySource = 'manual' | 'ai' | 'ai-adjusted'

export interface BoundaryData {
  leftBoundary: number
  rightBoundary: number
  source: BoundarySource
  confidence: number | null
}

// A provider's prediction for one boundary pair, before it's been reviewed —
// same shape as BoundaryData minus `source` (which is exactly what
// resolveProvenance below computes). No detection provider exists yet
// (Phase 14B/14C); this type exists now so resolveProvenance has a stable,
// already-correct signature to be extended into later.
export interface BoundaryPrediction {
  leftBoundary: number
  rightBoundary: number
  confidence: number | null
}

// Pure resolution of a submitted boundary pair's provenance (Phase 14A).
// `prediction: null` (every caller today, since no detection provider is
// wired in yet) always resolves to 'manual' with null confidence — bit-
// identical to the hardcoded stamp this replaces. Once a real prediction
// exists (14C): exact integer equality against the prediction means the
// operator accepted it untouched ('ai'); any difference means they moved it
// ('ai-adjusted'). Predictions are rounded to ints before being applied to
// the canvas, so integer equality (not a tolerance/epsilon) is the correct
// "untouched" test.
export function resolveProvenance(
  submitted: { leftBoundary: number; rightBoundary: number },
  prediction: BoundaryPrediction | null
): { source: BoundarySource; confidence: number | null } {
  if (prediction === null) return { source: 'manual', confidence: null }
  const untouched =
    submitted.leftBoundary === prediction.leftBoundary &&
    submitted.rightBoundary === prediction.rightBoundary
  return { source: untouched ? 'ai' : 'ai-adjusted', confidence: prediction.confidence }
}

export type AnnotationStatus = 'unannotated' | 'annotated'

export interface WatchAnnotation {
  sku: string
  status: AnnotationStatus
  spliceBoundaries: BoundaryData | null
  scaleBoundaries: BoundaryData | null
}

export type GuideMode = 'uniform' | 'free'

export interface BatchState {
  inputFolder: string
  outputFolder: string
  spreadsheetPath: string
  match: MatchSummary
  // Automatic/Manual workflow abstraction (Phase 11.5C, constants/processingMode.ts).
  // Manual continues to behave exactly as before this phase (splice
  // boundaries are always hand-drawn); Automatic establishes the workflow
  // abstraction only — AI-driven Watch masking arrives in Phase 12. Optional
  // so batches recorded before this field existed still parse.
  processingMode?: ProcessingMode
}
