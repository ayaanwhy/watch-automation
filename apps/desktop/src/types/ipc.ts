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

// ── Generic product metadata (Phase 12B) ────────────────────────────────────
// SKU/Category/Sub-Category/Dimensions — a product-agnostic metadata sheet
// system; Earring is the first consumer, not the reason it exists (see
// IMPLEMENTATION_PLAN.md, Phase 12 Resolved Decision 1). Mirrors
// SpreadsheetRowData/MatchSummary's existing pattern: a renderer-facing DTO
// shape kept separate from @wpa/processing's own internal types (structurally
// identical by design, not a direct re-export).

export interface ProductMetadataRowData {
  sku: string
  category: string
  subCategory: string
  dimensions: string
}

export interface ProductMetadataSummary {
  totalMetadataRecords: number
  totalImages: number
  matched: string[]
  missingImages: string[]
  missingMetadataRecords: string[]
  duplicateMetadataSkus: string[]
  duplicateImageSkus: string[]
  rows: Record<string, ProductMetadataRowData>
}

// Earring-specific classification layered on top of the generic match
// summary by metadataHandlers.ts (app-side — see constants/earringClassification.ts).
// unmapped lists matched SKUs whose Sub-Category didn't resolve to a known
// type, reported explicitly rather than guessed.
export interface ProductMetadataClassification {
  bySku: Record<string, import('../constants/earringClassification').EarringType>
  unmapped: string[]
}

export interface ProductMetadataLoadPayload {
  metadataFilePath: string
  inputFolder: string
}

export interface ProductMetadataLoadResult {
  ok: boolean
  errors: string[]
  match?: ProductMetadataSummary
  classification?: ProductMetadataClassification
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

// 'earring' added in Phase 12A — Universal Preprocessing support only
// (plugins/earring.py, target selector). The dedicated Earring editing
// destination/workflow is introduced in Phase 12C.
export type ProductType = 'watch' | 'bracelet' | 'ring' | 'earring' | 'generic'

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
  // Preprocessing quality preset (Phase 11.5B) — replaces the old individual
  // mask/edge/SAM tuning fields. The renderer only selects between named
  // presets ('fast' | 'balanced' | 'quality', see constants/preprocessingPresets.ts);
  // the main process resolves the preset into the full parameter set and
  // builds the CLI args from that. Omitted means the default preset
  // ('balanced') applies.
  preset?: import('../constants/preprocessingPresets').PreprocessingPreset
  birefnetModelRoot?: string
  samCheckpoint?: string
}

export type PreprocessStartResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string }

// ── Preprocessing preset definitions (11.5B follow-up) ──────────────────────
// What Fast/Balanced/Quality actually mean, editable only from Settings —
// see constants/preprocessingPresets.ts for the value shape and factory
// defaults, and electron/services/preprocessingPresetDefinitions.ts for how
// the main process persists/resolves the active (possibly-edited) values.
export interface PreprocessingPresetDefinitionSavePayload {
  preset: import('../constants/preprocessingPresets').PreprocessingPreset
  values: import('../constants/preprocessingPresets').PreprocessingPresetValues
}

export interface ShadowProfileDefinitionSavePayload {
  name: import('../constants/shadowProfiles').ShadowProfileName
  values: import('../constants/shadowProfiles').ShadowProfileValues
}

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

// ── Preprocessing → Editing hand-off preparation (Phase 10F) ────────────────
// Triggered from the EditingHandoffDialog after a successful preprocessing
// run, for any destination product (Watch/Ring/Bracelet) — generalized from
// the original Watch-only "Continue to Watch Processing" one-click action.
// Optionally trims each image to its non-transparent bounding box and/or
// rotates it, writing the result into a new sibling folder — the original
// preprocessing output is never modified. trim=true/rotate='ccw' reproduces
// the original hardcoded Watch behavior exactly.

export type EditingHandoffRotate = 'none' | 'cw' | 'ccw' | '180'

export interface EditingHandoffPayload {
  sourceDir: string
  trim: boolean
  rotate: EditingHandoffRotate
  // Phase 12A — unconditional, aspect-preserving normalization to a fixed
  // height, applied after trim/rotate. Omitted means no resize step (every
  // caller before Earring). Surfaced in EditingHandoffDialog.tsx's UI
  // alongside the Earring destination itself (Phase 12C).
  resizeToHeight?: number
}

export type EditingHandoffResult =
  | { ok: true; preparedDir: string; imageCount: number; skippedCount: number }
  | { ok: false; error: string }

export interface PrepareProgressPayload {
  completed: number
  total: number
}

// Remembers the user's last-used Trim/Rotate/Destination choices (Phase
// 10F) — one shared slot, not per-product, since the dialog itself already
// lets the destination vary per use.
export interface EditingHandoffOptionsPrefs {
  trim: boolean
  rotate: EditingHandoffRotate
  destination: 'watch' | 'ring' | 'bracelet' | 'earring'
}

// Appearance overrides (Phase 13H, Settings > Appearance). 'system' defers
// to the OS media query — the default, and the only behavior that existed
// before this phase; 'on'/'off' force the data-reduced-motion/
// data-reduced-transparency attributes global.css's
// :root[data-reduced-motion='true'|'false'] rules already handle (Phase
// 13A scaffolding) — see main.tsx's bootstrap comment for the exact
// mechanism this slots into. ambientIntensity scales AmbientBackground's
// blob opacity via a CSS custom property (Phase 13C component, wired here).
export type AppearanceOverride = 'system' | 'on' | 'off'

export interface AppearancePrefs {
  reducedMotion: AppearanceOverride
  reducedTransparency: AppearanceOverride
  ambientIntensity: 'off' | 'subtle' | 'standard'
}

// One-shot Shadow Profile preview (Phase 13H) — renders a bundled sample
// silhouette through the real shadow.py engine (preprocessing/
// shadow_preview.py), never a CSS approximation. Isolated from every real
// runner's own default path: this always renders exactly the candidate
// `values` passed in, never the persisted/default definition.
export interface ShadowPreviewRenderPayload {
  values: import('../constants/shadowProfiles').ShadowProfileValues
  pythonPath?: string
}

export type ShadowPreviewRenderResult =
  | { ok: true; previewPath: string }
  | { ok: false; error: string }

// ── Batch registry (Phase 9B) ───────────────────────────────────────────────
// The Batch is the primary workflow entity; see types/batch.ts.

export interface BatchCreatePayload {
  sourceDir: string
  pipeline: import('./batch').StageType[]
  title?: string
  mode?: import('./batch').BatchMode
}

export interface BatchStageUpdatePayload {
  id: string
  stageType: import('./batch').StageType
  patch: import('./batch').StagePatch
}

// Manual QA review (Phase 11.5E) — toggles one image's needsFixing flag.
// Scoped to the 'editing' stage type for this phase (see IMPLEMENTATION_PLAN.md).
export interface BatchSetImageNeedsFixingPayload {
  id: string
  stageType: import('./batch').StageType
  imageName: string
  needsFixing: boolean
}

// Hoop Manual boundary placement (Phase 12E) — persists one SKU's split
// position into the editing stage's config.hoopSplits as it's placed (see
// batchRegistry.setHoopSplit). splitX is normalized: a fraction (0-1) of
// the source image's own full width, not the hoop's own bounding box —
// resolution-independent, and directly convertible back to the same
// absolute-pixel space hoop_mask.py's automatic detector already works in.
export interface BatchSetHoopSplitPayload {
  id: string
  stageType: import('./batch').StageType
  sku: string
  splitX: number
}

export interface BatchRenamePayload {
  id: string
  title: string
}

// Testing/Production is editable after creation (Phase 10F correction).
export interface BatchSetModePayload {
  id: string
  mode: import('./batch').BatchMode
}

// Phase 9E.1 — lets "Resume" find the batch a Watch session already belongs
// to (never creating a duplicate) using the same three fields already stored
// on the stage, not a separately-persisted session key.
export interface BatchFindWatchPayload {
  inputFolder: string
  outputFolder: string
  spreadsheetPath: string
}

// Post-Phase-13 polish (Item 3) — Ring/Bracelet/Earring's analogue of
// BatchFindWatchPayload. There's no SessionFile for these products (no
// annotation step to resume — see ResumePrompt's doc comment), so "Resume"
// means finding the existing editing-stage batch for these exact
// inputDir/outputDir/product fields and reusing its id, relying on the
// Python runners' own idempotent-skip behavior to pick up where it left off.
export interface BatchFindEditingPayload {
  product: 'ring' | 'bracelet' | 'earring'
  inputFolder: string
  outputFolder: string
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
  // Recorded on the stage config and forwarded to the runner as --product
  // (Phase 10E), which selects between shank_mask.py (bracelet) and
  // ring_mask.py (ring) — see runner.py's module docstring.
  product: 'ring' | 'bracelet'
  // Fallback vertical split used when no hole topology is found. Optional
  // renderer override on an unchanged default (0.5), same pattern as SAM
  // tuning in PreprocessStartPayload.
  splitY?: number
  // Automatic/Manual workflow abstraction (Phase 11.5C, constants/processingMode.ts)
  // — Automatic runs the existing masking workflow before shadow generation;
  // Manual skips masking and proceeds straight to shadow generation. Omitted
  // means 'automatic', matching pre-11.5C behavior exactly.
  processingMode?: import('../constants/processingMode').ProcessingMode
}

// Phase 11.5D — lightweight pre-flight check before Start, mirroring the
// spirit of Watch's batch:validate without its spreadsheet/SKU-matching
// (Ring & Bracelet has neither). Reuses BatchValidationResult's shape
// (ok/errors/imageCount) rather than a near-duplicate type.
export interface RingBraceletValidatePayload {
  inputDir: string
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

// Ring and Bracelet remember separate last-used folders (product-keyed,
// mirroring PreprocessingFolderPrefs' one-file-per-concern shape) rather
// than sharing one slot — switching products shouldn't surface the other
// product's folders.
export interface RingBraceletFolderPrefs {
  inputDir: string | null
  outputDir: string | null
}

export interface RingBraceletFolderPrefsLoadPayload {
  product: 'ring' | 'bracelet'
}

export interface RingBraceletFolderPrefsSavePayload extends RingBraceletFolderPrefs {
  product: 'ring' | 'bracelet'
}

// ── Earring asset generation (Phase 12C) ────────────────────────────────────
// Consumes Universal Preprocessing's already-prepared, resized-to-1000px
// transparent PNGs (Phase 12A). Wire contract deliberately independent of
// RingBraceletStartPayload/Event/Done, per the same "keep asset-generation
// pipelines cleanly separated" precedent Ring & Bracelet itself established
// relative to Preprocessing.

export interface EarringStartPayload {
  inputDir: string
  outputDir: string
  batchId?: string
  pythonPath?: string
  // Path to the product metadata sheet (CSV/XLSX) — SKU/Category/Sub-Category/
  // Dimensions (Phase 12B). Parsed, matched, and classified into a resolved
  // {sku: earringType} sidecar by the main process before the runner spawns
  // (electron/ipc/earringHandlers.ts) — the Python runner never re-interprets
  // Category/Sub-Category itself (Phase 12C explicit requirement).
  metadataFilePath: string
  processingMode?: import('../constants/processingMode').ProcessingMode
}

// Mirrors RingBraceletValidatePayload's lightweight pre-flight spirit,
// applied to the input image folder — the metadata sheet's own errors
// surface through earring:start's own result instead (mirroring batch:load's
// pattern, since sheet parsing/matching genuinely can fail in ways a plain
// folder check can't).
export interface EarringValidatePayload {
  inputDir: string
}

export type EarringStartResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string }

export type EarringEventPayload = { jobId: string } & (
  | { type: 'start'; total: number; images: string[] }
  | { type: 'progress'; index: number; total: number; image: string; stage: string; status: 'start' }
  | {
      type: 'complete'
      index: number
      total: number
      image: string
      compare: string
      frontImage: string
      earringType: string
      duration_ms: number
      // Hoop only (Phase 12D) — Stud/Drop's complete events never carry
      // these. frontFullImage is an unmodified duplicate of compare;
      // detected mirrors Ring & Bracelet's own confidence signal (false ->
      // low-confidence, route to manual review), reported here from
      // hoop_mask.py's (mask, detected) contract.
      frontFullImage?: string
      detected?: boolean
    }
  | { type: 'error'; index: number; total: number; image: string; error: string; fatal: boolean }
  | { type: 'fatal'; error: string }
  | { type: 'cancel_requested' }
  | { type: 'done'; succeeded: number; failed: number; total_duration_ms: number; cancelled: boolean }
)

export interface EarringDonePayload {
  jobId: string
  exitCode: number | null
  succeeded: number
  failed: number
  totalDurationMs: number
  cancelledByUser: boolean
  spawnError?: string
}

// One shared slot (unlike Ring/Bracelet's product-keyed prefs) — there's
// only one Earring product to remember folders for. Bundles the metadata
// sheet path alongside the folders rather than a separate one-string prefs
// file, since all three are "this screen's last-used inputs" together.
export interface EarringFolderPrefs {
  inputDir: string | null
  outputDir: string | null
  metadataFilePath: string | null
}

// ── Review-sidebar thumbnails (Item 6, post-Phase-13 polish) ───────────────
// See electron/services/thumbnailCache.ts for the full rationale.

export interface ThumbnailGetPayload {
  path: string
}

export type ThumbnailGetResult =
  | { ok: true; thumbnailPath: string }
  | { ok: false; error: string }

// ── Watch AI boundary detection (Phase 14B) ─────────────────────────────────
// SAM3 Watch Segmentation API (watchdialcoord.clouddeploy.in, live as of
// 2026-09-15). Verified against a real successful response (2026-09-16,
// sampledata/1688KM11.png): the service returns one bounding box for the
// watch case/dial only — the bracelet/straps fall outside it — so it maps
// to scaleBoundaries (dial/case edges) exclusively. It never informs
// spliceBoundaries (the strap-cut points), which this provider simply has
// no data for. The live schema (captured from the real /openapi.json, not
// assumed) has no confidence field at all, so confidence is always null
// from this provider — by design, not a placeholder for "not implemented."
export interface BoundaryDetectPayload {
  imagePath: string
}

export interface BoundaryPredictionPair {
  leftBoundary: number
  rightBoundary: number
}

export type BoundaryDetectResult =
  | { ok: true; spliceBoundaries: null; scaleBoundaries: BoundaryPredictionPair | null; confidence: null }
  | { ok: false; error: string; retryable: boolean }
