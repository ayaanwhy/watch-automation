export const SESSION_VERSION = 2

export interface SessionAnnotation {
  sku: string
  status: 'unannotated' | 'annotated'
  boundaries: {
    leftBoundary: number
    rightBoundary: number
    source: 'manual' | 'ai'
    confidence: number | null
  } | null
  processingStatus?: 'pending' | 'complete' | 'failed' | null
  processingError?: string | null
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
  metadata: Record<string, unknown>
}
