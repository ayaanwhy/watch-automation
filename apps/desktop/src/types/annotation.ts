import type { MatchSummary } from './ipc'

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
  boundaries: BoundaryData | null
  status: AnnotationStatus
}

export type GuideMode = 'uniform' | 'free'

export interface BatchState {
  inputFolder: string
  outputFolder: string
  match: MatchSummary
}
