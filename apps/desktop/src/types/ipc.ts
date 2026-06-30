export interface OpenFileOptions {
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface BatchValidatePayload {
  inputFolder: string
  spreadsheetPath: string
  outputFolder: string
}

export interface BatchValidationResult {
  ok: boolean
  errors: string[]
  imageCount?: number
}

export interface SpreadsheetRowData {
  sku: string
  widthMm: number
  heightMm: number
  measureBy: string
}

export interface MatchSummary {
  totalSpreadsheetRecords: number
  totalImages: number
  matched: string[]
  missingImages: string[]
  missingSpreadsheetRecords: string[]
  duplicateSpreadsheetSkus: string[]
  duplicateImageSkus: string[]
  rows: Record<string, SpreadsheetRowData>
}

export interface BatchLoadPayload {
  inputFolder: string
  spreadsheetPath: string
}

export interface BatchLoadResult {
  ok: boolean
  errors: string[]
  match?: MatchSummary
}

export interface SessionSavePayload {
  outputFolder: string
  session: import('./session').SessionFile
}

export interface SessionSaveResult {
  ok: boolean
  error?: string
}

export interface SessionLoadPayload {
  inputFolder: string
  outputFolder: string
  spreadsheetPath: string
}

export interface SessionLoadResult {
  ok: boolean
  session: import('./session').SessionFile | null
  error?: string
}

export interface LastBatchPrefs {
  inputFolder: string | null
  spreadsheetPath: string | null
  outputFolder: string | null
}

export interface ProcessWatchPayload {
  inputFolder: string
  outputFolder: string
  sku: string
  spliceBoundaries: { leftBoundary: number; rightBoundary: number }
  scaleBoundaries: { leftBoundary: number; rightBoundary: number } | null
  widthMm: number
}

export interface ProcessWatchResult {
  ok: boolean
  sku: string
  outputPath?: string
  error?: string
}

export type QueueStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'failed'

export interface QueueItemPublic {
  id: string
  sku: string
  status: QueueStatus
  error: string | null
  enqueuedAt: string
  completedAt: string | null
  spliceBoundaries: { leftBoundary: number; rightBoundary: number }
  scaleBoundaries: { leftBoundary: number; rightBoundary: number } | null
  widthMm: number
}

export interface QueueAddPayload {
  sku: string
  inputFolder: string
  outputFolder: string
  spliceBoundaries: { leftBoundary: number; rightBoundary: number }
  scaleBoundaries: { leftBoundary: number; rightBoundary: number } | null
  widthMm: number
}

export interface QueueRestorePayload {
  items: import('./session').SessionQueueItem[]
  inputFolder: string
  outputFolder: string
}

// ── Preprocessing ──────────────────────────────────────────────────────────────

export interface PreprocessStartPayload {
  inputDir: string
  outputDir: string
  // Optional manual override of the Python interpreter; when omitted the
  // main process auto-resolves one (see pythonResolver.ts).
  pythonPath?: string
  scaleFactor?: 1 | 2 | 4
  objectType?: string
  background?: string
  backgroundColorHex?: string
  outputPpi?: number
  outputSuffix?: string
  refineForeground?: boolean
  edgeMode?: 'none' | 'sharpen' | 'soften'
  edgeStrength?: number
  maskBlur?: number
  maskOffset?: number
  birefnetModelRoot?: string
  samCheckpoint?: string
}

export type PreprocessStartResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string }

export interface PreprocessMask {
  index: number
  path: string
  bbox: number[]
  area: number
  predicted_iou: number
  stability_score: number
}

export type PreprocessEventPayload = { jobId: string } & (
  | { type: 'initializing'; stage: string }
  | { type: 'start'; total: number; images: string[] }
  | { type: 'progress'; index: number; total: number; image: string; stage: string; status: 'start' | 'done'; duration_ms?: number }
  | { type: 'heartbeat'; image: string; stage: string; elapsed_ms: number }
  | { type: 'complete'; index: number; total: number; image: string; output: string; masks: PreprocessMask[]; duration_ms: number; timings: Record<string, number> }
  | { type: 'error'; index: number; total: number; image: string; error: string; fatal: boolean }
  | { type: 'fatal'; error: string }
  | { type: 'cancel_requested' }
  | { type: 'done'; succeeded: number; failed: number; total_duration_ms: number; cancelled: boolean }
)

export interface PreprocessDonePayload {
  jobId: string
  exitCode: number | null
  succeeded: number
  failed: number
  totalDurationMs: number
  cancelledByUser: boolean
  spawnError?: string
}

export interface PreprocessResolveResult {
  pythonPath: string | null
}
