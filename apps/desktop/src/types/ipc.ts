export interface OpenFileOptions {
  filters?: Array<{ name: string; extensions: string[] }>
  // Identifies which picker this is (e.g. 'watch-spreadsheet') so its dialog
  // remembers its own last-used location independently of every other
  // picker — Phase 9E.1, replacing one shared/global remembered folder.
  historyKey?: string
}

export interface OpenFolderOptions {
  historyKey?: string
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

export type UpscaleFactor = 1 | 2 | 4

export type ProductType = 'watch' | 'bracelet' | 'ring' | 'generic'

// Phase 10A — which preprocessing stages to run. Not persisted (each run
// defaults to both); recorded on the batch stage config purely for history.
export type PreprocessOperation = 'background_removal' | 'upscale'

export interface PreprocessingFolderPrefs {
  inputDir: string | null
  outputDir: string | null
}

export interface PreprocessStartPayload {
  inputDir: string
  outputDir: string
  // The Batch (Phase 9B/9C) whose preprocessing stage this run belongs to.
  // When present, the main process writes that stage's running/terminal
  // status directly to the batch registry as the job progresses — the
  // renderer no longer owns recording stage status (see batchRegistry.ts).
  batchId?: string
  // Optional manual override of the Python interpreter; when omitted the
  // main process auto-resolves one (see pythonResolver.ts).
  pythonPath?: string
  scaleFactor?: 1 | 2 | 4
  objectType?: string
  // Which stages to run (Phase 10A). Omitted/undefined means both — matches
  // pre-10A behavior exactly for any caller that doesn't set this.
  operations?: PreprocessOperation[]
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
  // SAM tuning — renderer-controlled overrides forwarded to electron_runner.py via CLI.
  // When absent, config.py SAM defaults apply unchanged.
  samPointsPerSide?: number
  samPointsPerBatch?: number
  samPredIouThresh?: number
  samStabilityScoreThresh?: number
  samMaxMasks?: number
  samMultimaskOutput?: boolean
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

// Persisted SAM tuning settings. Defaults match the current config.py SAM values.
export interface SamTuningPrefs {
  pointsPerSide: number
  pointsPerBatch: number
  predIouThresh: number
  stabilityScoreThresh: number
  maxMasks: number
  multimaskOutput: boolean
}

// ── Watch Processing hand-off preparation ───────────────────────────────────
// Triggered only when the user clicks "Continue to Watch Processing" after a
// successful preprocessing run. Trims each image to its non-transparent
// bounding box, rotates it 90° counter-clockwise, and writes the result into
// a new sibling folder — the original preprocessing output is never modified.

export interface PrepareForWatchProcessingPayload {
  sourceDir: string
}

export type PrepareForWatchProcessingResult =
  | { ok: true; preparedDir: string; imageCount: number; skippedCount: number }
  | { ok: false; error: string }

export interface PrepareProgressPayload {
  completed: number
  total: number
}

// ── Batch registry (Phase 9B) ───────────────────────────────────────────────
// The Batch is the primary workflow entity; see types/batch.ts.

export interface BatchCreatePayload {
  sourceDir: string
  pipeline: import('./batch').StageType[]
  title?: string
}

export interface BatchStageUpdatePayload {
  id: string
  stageType: import('./batch').StageType
  patch: import('./batch').StagePatch
}

export interface BatchRenamePayload {
  id: string
  title: string
}

// Phase 9E.1 — lets "Resume" find the batch a Watch session already belongs
// to (never creating a duplicate) using the same three fields already stored
// on the stage, not a separately-persisted session key.
export interface BatchFindWatchPayload {
  inputFolder: string
  outputFolder: string
  spreadsheetPath: string
}

// ── Ring & Bracelet asset generation (Phase 10C) ────────────────────────────
// Consumes Universal Preprocessing's already-prepared transparent PNGs — this
// stage never touches raw photos or runs its own background removal. Wire
// contract is deliberately independent of PreprocessStartPayload/Event/Done
// (not reused) even though the shapes rhyme, per "keep preprocessing and
// asset generation cleanly separated."

export interface RingBraceletStartPayload {
  inputDir: string
  outputDir: string
  // The Batch (see types/batch.ts) whose 'editing' stage this run belongs
  // to — mirrors PreprocessStartPayload.batchId's role for preprocessing.
  batchId?: string
  pythonPath?: string
  // Recorded on the stage config; the runner's own algorithm behavior does
  // not depend on it (generate_wrap_mask doesn't distinguish ring/bracelet).
  product: 'ring' | 'bracelet'
  // Fallback vertical split used when no hole topology is found. Optional
  // renderer override on an unchanged default (0.5), same pattern as SAM
  // tuning in PreprocessStartPayload.
  splitY?: number
}

export type RingBraceletStartResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string }

export type RingBraceletEventPayload = { jobId: string } & (
  | { type: 'start'; total: number; images: string[] }
  | { type: 'progress'; index: number; total: number; image: string; stage: string; status: 'start' }
  | {
      type: 'complete'
      index: number
      total: number
      image: string
      frontFullImage: string
      frontImage: string
      detected: boolean
      duration_ms: number
    }
  | { type: 'error'; index: number; total: number; image: string; error: string; fatal: boolean }
  | { type: 'fatal'; error: string }
  | { type: 'cancel_requested' }
  | { type: 'done'; succeeded: number; failed: number; total_duration_ms: number; cancelled: boolean }
)

export interface RingBraceletDonePayload {
  jobId: string
  exitCode: number | null
  succeeded: number
  failed: number
  totalDurationMs: number
  cancelledByUser: boolean
  spawnError?: string
}
