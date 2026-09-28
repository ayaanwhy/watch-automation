// Turns the runners' structured completion signals into AutomationErrors.
// Only ever looks at structured fields (failureKind, counts, exception class
// names) — never at free-text messages from external services.
import { makeAutomationError, type AutomationError } from '../../../src/sandbox/types/automationError'

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
