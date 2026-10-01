// Turns the runners' structured completion signals into AutomationErrors.
// Only ever looks at structured fields (failureKind, counts, exception class
// names) — never at free-text messages from external services.
import { makeAutomationError, type AutomationError, type AutomationErrorCode } from '../../../src/sandbox/types/automationError'

// The Ring runner tags every ring-segmentation failure with a stable
// `[RING_SEGMENTATION_<KIND>]` token at the START of its message (a contract
// owned by our own runner, like a Python exception class name) — the only
// thing parsed here; the rest of the text is kept as technical detail.
const RING_SEGMENTATION_TOKEN = /^\[RING_SEGMENTATION_(MODEL_UNAVAILABLE|RUNTIME_ERROR|INFERENCE_FAILED|OUTPUT_MISSING|OUTPUT_INVALID)\]\s*/
export const RING_SEGMENTATION_STAGE_LABEL = 'Ring Segmentation'

export function ringSegmentationFailure(text: string | undefined | null, ctx: { sku?: string }): AutomationError | null {
  const match = text ? RING_SEGMENTATION_TOKEN.exec(text) : null
  if (!match || !text) return null
  return makeAutomationError(`RING_SEGMENTATION_${match[1]}` as AutomationErrorCode, {
    productType: 'ring',
    sku: ctx.sku,
    stageDetail: RING_SEGMENTATION_STAGE_LABEL,
    technicalMessage: text.replace(RING_SEGMENTATION_TOKEN, ''),
  })
}

export interface RunnerDoneLike {
  succeeded: number
  failed: number
  cancelledByUser?: boolean
  spawnError?: string
  failureKind?: 'spawn' | 'timeout'
  fatalError?: string
}

// null = the job ended normally with at least one success (per-image
// failures, if any, were reported individually as they happened).
export function failureFromRunnerDone(
  done: RunnerDoneLike,
  ctx: { stage: 'preprocessing' | 'editing'; productType: string },
): AutomationError | null {
  const isEditing = ctx.stage === 'editing'
  const base = { productType: ctx.productType }

  if (done.spawnError) {
    if (done.failureKind === 'timeout') {
      return makeAutomationError(isEditing ? 'EDITING_TIMEOUT' : 'PREPROCESSING_FAILED', { ...base, technicalMessage: done.spawnError })
    }
    return makeAutomationError(isEditing ? 'EDITING_LAUNCH_FAILED' : 'PREPROCESSING_START_FAILED', { ...base, technicalMessage: done.spawnError })
  }
  if (done.succeeded > 0) return null
  if (done.cancelledByUser) return null

  if (done.fatalError) {
    if (isEditing && ctx.productType === 'ring') {
      const ring = ringSegmentationFailure(done.fatalError, {})
      if (ring) return ring
    }
    // Python's own exception class — a stable contract, unlike free text.
    const missing = /ModuleNotFoundError: No module named '([^']+)'|No module named '([^']+)'/.exec(done.fatalError)
    if (missing) {
      return makeAutomationError('PYTHON_DEPENDENCY_MISSING', { ...base, detail: missing[1] ?? missing[2], technicalMessage: done.fatalError })
    }
    return makeAutomationError(isEditing ? 'EDITING_RUNNER_FAILED' : 'PREPROCESSING_FAILED', { ...base, technicalMessage: done.fatalError })
  }
  if (done.failed > 0) {
    return makeAutomationError(isEditing ? 'EDITING_RUNNER_FAILED' : 'PREPROCESSING_FAILED', {
      ...base,
      technicalMessage: `The ${ctx.stage} job failed for every image.`,
    })
  }
  return makeAutomationError(isEditing ? 'EDITING_OUTPUT_MISSING' : 'PREPROCESSING_INVALID_OUTPUT', {
    ...base,
    technicalMessage: `The ${ctx.stage} job finished without processing any image.`,
  })
}
