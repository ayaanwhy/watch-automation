import type { MatchSummary } from './ipc'
import type { ProcessingMode } from '../constants/processingMode'

export const MIN_GUIDE_SEPARATION = 10

export interface BoundaryData {
  leftBoundary: number
  rightBoundary: number
  source: 'manual' | 'ai'
  confidence: number | null
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
