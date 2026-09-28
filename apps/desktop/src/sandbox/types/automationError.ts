// Automation-engine structured error model. Pure data + pure functions — no
// Electron/React/Node dependency — so the engine (main process), a future
// API adapter, a CLI and the Sandbox UI can all produce/consume exactly the
// same shape. Every failure the engine surfaces is one of these: WHAT
// failed (message), WHERE (stage/product/sku), WHY when known
// (technicalMessage/cause), WHETHER it's retryable, and WHAT to do next
// (action). Raw tracebacks/stderr only ever live in technicalMessage/cause
// (shown behind an expander, never as the primary message).

export type AutomationStage =
  | 'configuration'
  | 'preflight'
  | 'input'
  | 'preprocessing'
  | 'ai_detection'
  | 'editing'
  | 'post_processing'
  | 'filesystem'
  | 'run'

export const AUTOMATION_STAGE_LABELS: Record<AutomationStage, string> = {
  configuration: 'Configuration',
  preflight: 'Preflight',
  input: 'Input',
  preprocessing: 'Preprocessing',
  ai_detection: 'AI Detection',
  editing: 'Editing',
  post_processing: 'Post-processing',
  filesystem: 'Filesystem',
  run: 'Run',
}

export type AutomationErrorCode =
  // input
  | 'SOURCE_IMAGE_MISSING'
  | 'SOURCE_IMAGE_UNREADABLE'
  | 'SOURCE_IMAGE_UNSUPPORTED_FORMAT'
  | 'SKU_MISSING'
  | 'SKU_DUPLICATE'
  | 'PRODUCT_TYPE_MISSING'
  | 'SOURCE_FOLDER_MISSING'
  | 'METADATA_ROW_MISSING'
  | 'METADATA_INVALID'
  | 'MEASUREMENT_INVALID'
  | 'MISSING_WATCH_MEASURE_BY'
  | 'MISSING_WATCH_WIDTH'
  | 'MISSING_EARRING_CLASSIFICATION'
  | 'MISSING_GEMSTONE_SHAPE'
  | 'INVALID_GEMSTONE_DIMENSIONS'
  | 'PRODUCT_PIPELINE_UNAVAILABLE'
  // preprocessing
  | 'PYTHON_UNAVAILABLE'
  | 'PYTHON_DEPENDENCY_MISSING'
  | 'PREPROCESSING_START_FAILED'
  | 'BACKGROUND_REMOVAL_FAILED'
  | 'UPSCALE_FAILED'
  | 'TRIM_FAILED'
  | 'ROTATE_FAILED'
  | 'RESIZE_FAILED'
  | 'PREPROCESSING_INVALID_INPUT'
  | 'PREPROCESSING_INVALID_OUTPUT'
  | 'PREPROCESSING_FAILED'
  // watch AI
  | 'WATCH_BOUNDARY_UNAVAILABLE'
  | 'WATCH_BOUNDARY_TIMEOUT'
  | 'WATCH_BOUNDARY_HTTP_ERROR'
  | 'WATCH_BOUNDARY_REJECTED'
  | 'WATCH_BOUNDARY_INVALID'
  | 'WATCH_BOUNDARY_MALFORMED_RESPONSE'
  | 'WATCH_IMAGE_UNREADABLE'
  | 'WATCH_PROCESSING_FAILED'
  // editing
  | 'EDITING_RUNNER_FAILED'
  | 'EDITING_LAUNCH_FAILED'
  | 'EDITING_TIMEOUT'
  | 'EDITING_MALFORMED_RESULT'
  | 'EDITING_OUTPUT_MISSING'
  | 'EDITING_OUTPUT_INVALID'
  | 'EDITING_TRIM_FAILED'
  // post-processing
  | 'POSTPROCESSING_PYTHON_UNAVAILABLE'
  | 'POSTPROCESSING_DEPENDENCY_MISSING'
  | 'POSTPROCESSING_SCRIPT_MISSING'
  | 'POSTPROCESSING_LAUNCH_FAILED'
  | 'POSTPROCESSING_NONZERO_EXIT'
  | 'POSTPROCESSING_MALFORMED_RESULT'
  | 'POSTPROCESSING_OUTPUT_MISSING'
  | 'POSTPROCESSING_OUTPUT_INVALID'
  | 'POSTPROCESSING_PATH_FAILURE'
  | 'POSTPROCESSING_CAPABILITY_UNAVAILABLE'
  // filesystem
  | 'WORKSPACE_CREATE_FAILED'
  | 'PERMISSION_DENIED'
  | 'SOURCE_DISAPPEARED'
  | 'DESTINATION_UNAVAILABLE'
  | 'DISK_WRITE_FAILED'
  | 'UNSAFE_PATH'
  // run
  | 'PREFLIGHT_FAILED'
  | 'CONFIGURATION_INVALID'
  | 'RUN_INTERRUPTED'
  | 'RETRY_NOT_APPLICABLE'
  | 'INTERNAL_ERROR'

export interface AutomationError {
  code: AutomationErrorCode
  stage: AutomationStage
  // Finer-grained "where": a preprocessing sub-step ("Background Removal"),
  // a post-processing script id ("compressorNew"), ...
  stageDetail?: string
  productType?: string
  sku?: string
  // Concise, human-readable, safe to show as the primary message.
  message: string
  // Debugging only (stderr tail, exception text, HTTP status, ...). Shown
  // behind an expander; never the primary message.
  technicalMessage?: string
  retryable: boolean
  action?: string
  cause?: string
}

export interface AutomationErrorContext {
  stageDetail?: string
  productType?: string
  sku?: string
  technicalMessage?: string
  cause?: string
  // Free-form values a catalog message may interpolate (script id, path
  // description, ...).
  detail?: string
}

interface CatalogEntry {
  stage: AutomationStage
  message: (c: AutomationErrorContext) => string
  action: string | null
  retryable: boolean
}

const forSku = (c: AutomationErrorContext) => (c.sku ? ` for SKU ${c.sku}` : '')
const script = (c: AutomationErrorContext) => c.stageDetail ?? c.detail ?? 'the post-processing script'

export const AUTOMATION_ERROR_CATALOG: Record<AutomationErrorCode, CatalogEntry> = {
  SOURCE_IMAGE_MISSING: { stage: 'input', message: c => `The source image${forSku(c)} could not be found.`, action: 'Check that the image still exists at its source location (and that its drive is mounted), then retry.', retryable: true },
  SOURCE_IMAGE_UNREADABLE: { stage: 'input', message: c => `The source image${forSku(c)} is unreadable or corrupt.`, action: 'Replace the image with a valid copy and retry.', retryable: false },
  SOURCE_IMAGE_UNSUPPORTED_FORMAT: { stage: 'input', message: c => `The source image${forSku(c)} is in an unsupported format.`, action: 'Provide the image as PNG, JPEG or WebP.', retryable: false },
  SKU_MISSING: { stage: 'input', message: () => 'An image has no SKU.', action: 'Add a SKU to every image in the batch.', retryable: false },
  SKU_DUPLICATE: { stage: 'input', message: c => `SKU ${c.sku ?? ''} appears more than once in this batch.`.replace('  ', ' '), action: 'Make every SKU in the batch unique.', retryable: false },
  PRODUCT_TYPE_MISSING: { stage: 'input', message: c => `No product type is set${forSku(c)}.`, action: 'Set a supported product type in the batch metadata.', retryable: false },
  SOURCE_FOLDER_MISSING: { stage: 'input', message: () => 'The batch source folder could not be found.', action: 'Check the folder still exists and that its drive is mounted, then retry.', retryable: true },
  METADATA_ROW_MISSING: { stage: 'input', message: c => `No metadata row was found${forSku(c)}.`, action: 'Add the SKU to the batch metadata and retry.', retryable: false },
  METADATA_INVALID: { stage: 'input', message: c => `The batch metadata is invalid${forSku(c)}.`, action: 'Fix the metadata values and retry.', retryable: false },
  MEASUREMENT_INVALID: { stage: 'input', message: c => `The measurement${forSku(c)} is not a valid positive number.`, action: 'Correct the measurement in the batch metadata and retry.', retryable: false },
  MISSING_WATCH_MEASURE_BY: { stage: 'input', message: c => `Watch "Measure By" (Case or Dial) is missing${forSku(c)}.`, action: 'Set Measure By to Case or Dial in the batch metadata and retry.', retryable: false },
  MISSING_WATCH_WIDTH: { stage: 'input', message: c => `Watch measurement data is missing${forSku(c)}.`, action: 'Add the width measurement to the batch metadata and retry.', retryable: false },
  MISSING_EARRING_CLASSIFICATION: { stage: 'input', message: c => `Earring classification (Stud, Drop or Hoop) is missing${forSku(c)}.`, action: 'Set the earring type in the batch metadata and retry.', retryable: false },
  MISSING_GEMSTONE_SHAPE: { stage: 'input', message: c => `Gemstone shape is missing${forSku(c)}.`, action: 'Add the gemstone Shape to the batch metadata (it is required and is never guessed) and retry.', retryable: false },
  INVALID_GEMSTONE_DIMENSIONS: { stage: 'input', message: c => `Gemstone width/height are missing or invalid${forSku(c)}.`, action: 'Provide positive width and height (mm) in the batch metadata and retry.', retryable: false },
  PRODUCT_PIPELINE_UNAVAILABLE: { stage: 'configuration', message: c => `No processing pipeline is available for ${c.productType ?? 'this product type'}.`, action: 'Remove these items from the batch, or wait until the pipeline exists.', retryable: false },

  PYTHON_UNAVAILABLE: { stage: 'preflight', message: () => 'The Python runtime required for image processing is unavailable.', action: 'Install or configure the required Python environment and retry.', retryable: true },
  PYTHON_DEPENDENCY_MISSING: { stage: 'preflight', message: c => `A required Python package is missing${c.detail ? ` (${c.detail})` : ''}.`, action: 'Install the missing package in the Python environment and retry.', retryable: true },
  PREPROCESSING_START_FAILED: { stage: 'preprocessing', message: () => 'Preprocessing could not be started.', action: 'Check that no other preprocessing job is running and that the Python runtime is available, then retry.', retryable: true },
  BACKGROUND_REMOVAL_FAILED: { stage: 'preprocessing', message: c => `Background removal failed${forSku(c)}.`, action: 'Retry the run; if it keeps failing, check the image and the Python runtime.', retryable: true },
  UPSCALE_FAILED: { stage: 'preprocessing', message: c => `Upscaling failed${forSku(c)}.`, action: 'Retry the run; if it keeps failing, check the image and the Python runtime.', retryable: true },
  TRIM_FAILED: { stage: 'preprocessing', message: c => `Trimming failed${forSku(c)} (the image may have no visible content).`, action: 'Check the image has a non-transparent subject, then retry.', retryable: false },
  ROTATE_FAILED: { stage: 'preprocessing', message: c => `Rotation failed${forSku(c)}.`, action: 'Check the image is valid and retry.', retryable: true },
  RESIZE_FAILED: { stage: 'preprocessing', message: c => `Resizing failed${forSku(c)}.`, action: 'Check the image is valid and retry.', retryable: true },
  PREPROCESSING_INVALID_INPUT: { stage: 'preprocessing', message: c => `The preprocessing input${forSku(c)} is invalid.`, action: 'Check the source image and retry.', retryable: false },
  PREPROCESSING_INVALID_OUTPUT: { stage: 'preprocessing', message: c => `Preprocessing produced an invalid result${forSku(c)}.`, action: 'Retry the run.', retryable: true },
  PREPROCESSING_FAILED: { stage: 'preprocessing', message: c => `Preprocessing failed${forSku(c)}.`, action: 'Retry the run; expand the details for the technical reason.', retryable: true },

  WATCH_BOUNDARY_UNAVAILABLE: { stage: 'ai_detection', message: () => 'Watch boundary detection is currently unavailable.', action: 'Check the Watch AI service connection and retry.', retryable: true },
  WATCH_BOUNDARY_TIMEOUT: { stage: 'ai_detection', message: () => 'Watch boundary detection timed out.', action: 'Check the Watch AI service is responsive and retry.', retryable: true },
  WATCH_BOUNDARY_HTTP_ERROR: { stage: 'ai_detection', message: () => 'The Watch boundary detection service returned an error.', action: 'Retry shortly; if it persists, contact the Watch AI service owner.', retryable: true },
  WATCH_BOUNDARY_REJECTED: { stage: 'ai_detection', message: c => `No watch boundaries were detected${forSku(c)}.`, action: 'Check the image shows the watch clearly (or process this SKU manually).', retryable: false },
  WATCH_BOUNDARY_INVALID: { stage: 'ai_detection', message: c => `The detected watch boundaries${forSku(c)} were implausible.`, action: 'Check the image (or process this SKU manually).', retryable: false },
  WATCH_BOUNDARY_MALFORMED_RESPONSE: { stage: 'ai_detection', message: () => 'The Watch boundary service returned an unreadable response.', action: 'Retry shortly; if it persists, contact the Watch AI service owner.', retryable: true },
  WATCH_IMAGE_UNREADABLE: { stage: 'ai_detection', message: c => `The image${forSku(c)} could not be read for Watch detection.`, action: 'Check the image is valid and retry.', retryable: false },
  WATCH_PROCESSING_FAILED: { stage: 'editing', message: c => `Watch processing failed${forSku(c)}.`, action: 'Retry the run; expand the details for the technical reason.', retryable: true },

  EDITING_RUNNER_FAILED: { stage: 'editing', message: c => `${c.productType ? c.productType[0].toUpperCase() + c.productType.slice(1) : 'Product'} editing failed${forSku(c)}.`, action: 'Retry the run; expand the details for the technical reason.', retryable: true },
  EDITING_LAUNCH_FAILED: { stage: 'editing', message: () => 'The editing process could not be started.', action: 'Check the Python runtime and that no other editing job is running, then retry.', retryable: true },
  EDITING_TIMEOUT: { stage: 'editing', message: () => 'The editing process stopped responding and was abandoned.', action: 'Retry the run.', retryable: true },
  EDITING_MALFORMED_RESULT: { stage: 'editing', message: () => 'The editing process returned an unreadable result.', action: 'Retry the run.', retryable: true },
  EDITING_OUTPUT_MISSING: { stage: 'editing', message: c => `Editing finished but produced no output${forSku(c)}.`, action: 'Retry the run.', retryable: true },
  EDITING_TRIM_FAILED: { stage: 'editing', message: c => `Trimming to the edges failed${forSku(c)} (the image has no visible content).`, action: 'Check that background removal left a visible subject, then retry.', retryable: true },
  EDITING_OUTPUT_INVALID: { stage: 'editing', message: c => `Editing produced an invalid output${forSku(c)}.`, action: 'Retry the run.', retryable: true },

  POSTPROCESSING_PYTHON_UNAVAILABLE: { stage: 'post_processing', message: c => `${script(c)} could not run: the Python runtime is unavailable.`, action: 'Install or configure the required Python runtime and retry.', retryable: true },
  POSTPROCESSING_DEPENDENCY_MISSING: { stage: 'post_processing', message: c => `${script(c)} could not run: a required Python package is missing${c.detail ? ` (${c.detail})` : ''}.`, action: 'Install the missing package in the Python runtime and retry.', retryable: true },
  POSTPROCESSING_SCRIPT_MISSING: { stage: 'post_processing', message: c => `The ${script(c)} script is missing from this installation.`, action: 'Reinstall/repair the application so the post-processing scripts are present.', retryable: false },
  POSTPROCESSING_LAUNCH_FAILED: { stage: 'post_processing', message: c => `${script(c)} could not be started.`, action: 'Check the Python runtime and retry.', retryable: true },
  POSTPROCESSING_NONZERO_EXIT: { stage: 'post_processing', message: c => `${script(c)} failed while processing.`, action: 'Retry the run; expand the details for the technical reason.', retryable: true },
  POSTPROCESSING_MALFORMED_RESULT: { stage: 'post_processing', message: c => `${script(c)} finished but did not report a readable result.`, action: 'Retry the run.', retryable: true },
  POSTPROCESSING_OUTPUT_MISSING: { stage: 'post_processing', message: c => `${script(c)} completed, but the expected output artifact was not created.`, action: 'Check the post-processing runtime and retry the batch.', retryable: true },
  POSTPROCESSING_OUTPUT_INVALID: { stage: 'post_processing', message: c => `${script(c)} produced an invalid output.`, action: 'Check the input images and retry.', retryable: true },
  POSTPROCESSING_PATH_FAILURE: { stage: 'post_processing', message: c => `${script(c)} could not access its input/output folder.`, action: 'Check disk space and folder permissions, then retry.', retryable: true },
  POSTPROCESSING_CAPABILITY_UNAVAILABLE: { stage: 'post_processing', message: c => `${script(c)} is not available in this installation.`, action: 'This step cannot run until its required capability/metadata exists.', retryable: false },

  WORKSPACE_CREATE_FAILED: { stage: 'filesystem', message: () => 'The processing workspace could not be created.', action: 'Check free disk space and folder permissions, then retry.', retryable: true },
  PERMISSION_DENIED: { stage: 'filesystem', message: () => 'Permission was denied while accessing a file or folder.', action: 'Grant the application access to the folder and retry.', retryable: true },
  SOURCE_DISAPPEARED: { stage: 'filesystem', message: c => `A source file${forSku(c)} disappeared during processing.`, action: 'Check the source drive is still connected, then retry.', retryable: true },
  DESTINATION_UNAVAILABLE: { stage: 'filesystem', message: () => 'The destination folder is unavailable.', action: 'Check the destination is writable and retry.', retryable: true },
  DISK_WRITE_FAILED: { stage: 'filesystem', message: () => 'A file could not be written (the disk may be full).', action: 'Free up disk space and retry.', retryable: true },
  UNSAFE_PATH: { stage: 'filesystem', message: () => 'A path was rejected because it would leave the processing workspace.', action: 'Correct the SKU/file name so it contains no path separators, then retry.', retryable: false },

  PREFLIGHT_FAILED: { stage: 'preflight', message: c => `Preflight checks failed${c.detail ? `: ${c.detail}` : '.'}`, action: 'Fix the failing checks and start the run again.', retryable: true },
  CONFIGURATION_INVALID: { stage: 'configuration', message: c => `The configuration is invalid${c.detail ? `: ${c.detail}` : '.'}`, action: 'Correct the configuration and start again.', retryable: false },
  RUN_INTERRUPTED: { stage: 'run', message: () => 'This run was interrupted because the application closed while it was processing.', action: 'Start the run again.', retryable: true },
  RETRY_NOT_APPLICABLE: { stage: 'run', message: c => `This image cannot be retried${c.detail ? `: ${c.detail}` : '.'}`, action: 'Wait for the product to finish, or start a new run.', retryable: false },
  INTERNAL_ERROR: { stage: 'run', message: () => 'An unexpected error occurred.', action: 'Retry; if it persists, share the technical details with the developer.', retryable: true },
}

export function makeAutomationError(code: AutomationErrorCode, ctx: AutomationErrorContext = {}): AutomationError {
  const entry = AUTOMATION_ERROR_CATALOG[code]
  const error: AutomationError = {
    code,
    stage: entry.stage,
    message: entry.message(ctx),
    retryable: entry.retryable,
  }
  if (entry.action) error.action = entry.action
  if (ctx.stageDetail) error.stageDetail = ctx.stageDetail
  if (ctx.productType) error.productType = ctx.productType
  if (ctx.sku) error.sku = ctx.sku
  if (ctx.technicalMessage) error.technicalMessage = ctx.technicalMessage.slice(0, 2000)
  if (ctx.cause) error.cause = ctx.cause.slice(0, 500)
  return error
}

// Maps a thrown value (Node fs errors carry an errno `code`) to a filesystem
// AutomationError; anything unrecognized is INTERNAL_ERROR with the real
// message kept as technicalMessage. Never inspects free-text messages.
export function classifyThrownError(err: unknown, ctx: AutomationErrorContext = {}): AutomationError {
  const errno = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  const technicalMessage = ctx.technicalMessage ?? (err instanceof Error ? err.message : String(err))
  const withTech = { ...ctx, technicalMessage, cause: ctx.cause ?? (typeof errno === 'string' ? errno : undefined) }
  switch (errno) {
    case 'EACCES':
    case 'EPERM':
      return makeAutomationError('PERMISSION_DENIED', withTech)
    case 'ENOENT':
    case 'ENOTDIR':
      return makeAutomationError('SOURCE_DISAPPEARED', withTech)
    case 'ENOSPC':
    case 'EDQUOT':
      return makeAutomationError('DISK_WRITE_FAILED', withTech)
    case 'EROFS':
    case 'EBUSY':
      return makeAutomationError('DESTINATION_UNAVAILABLE', withTech)
    case 'ENAMETOOLONG':
      return makeAutomationError('UNSAFE_PATH', withTech)
    default:
      return makeAutomationError('INTERNAL_ERROR', withTech)
  }
}

export function isAutomationError(value: unknown): value is AutomationError {
  return typeof value === 'object' && value !== null && typeof (value as AutomationError).code === 'string' && typeof (value as AutomationError).message === 'string'
}

// One-line human summary — used wherever a legacy plain-string `error` field
// still has to carry the message (kept alongside the structured `failure`).
export function summarizeAutomationError(error: AutomationError): string {
  return error.stageDetail ? `${error.stageDetail}: ${error.message}` : error.message
}
