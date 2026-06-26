export const SESSION_VERSION = 3

export interface SessionQueueItem {
  id: string
  sku: string
  leftBoundary: number
  rightBoundary: number
  widthMm: number
  status: 'queued' | 'complete' | 'failed'
  error: string | null
  enqueuedAt: string
  completedAt: string | null
}

export interface SessionAnnotation {
  sku: string
  status: 'unannotated' | 'annotated'
  boundaries: {
    leftBoundary: number
    rightBoundary: number
    source: 'manual' | 'ai'
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
