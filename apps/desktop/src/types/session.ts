export const SESSION_VERSION = 4

export interface SessionQueueItem {
  id: string
  sku: string
  spliceBoundaries: { leftBoundary: number; rightBoundary: number }
  scaleBoundaries: { leftBoundary: number; rightBoundary: number } | null
  widthMm: number
  status: 'queued' | 'complete' | 'failed'
  error: string | null
  enqueuedAt: string
  completedAt: string | null
}

export interface SessionAnnotation {
  sku: string
  status: 'unannotated' | 'annotated'
  // 'ai-adjusted' widened in Phase 14A (types/annotation.ts's BoundarySource)
  // — deliberately NOT a SESSION_VERSION bump; see that file's comment.
  spliceBoundaries: {
    leftBoundary: number
    rightBoundary: number
    source: 'manual' | 'ai' | 'ai-adjusted'
    confidence: number | null
  } | null
  scaleBoundaries: {
    leftBoundary: number
    rightBoundary: number
    source: 'manual' | 'ai' | 'ai-adjusted'
    confidence: number | null
  } | null
}

export interface SessionFile {
  version: number
  createdAt: string
  updatedAt: string
  inputFolder: string
  outputFolder: string
  spreadsheetPath: string
  guideMode: 'uniform' | 'free'
  currentIndex: number
  annotations: SessionAnnotation[]
  processingQueue: SessionQueueItem[]
  metadata: Record<string, unknown>
}
