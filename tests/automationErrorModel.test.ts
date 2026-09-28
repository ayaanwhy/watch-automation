// Structured error model: every failure is an AutomationError (what/where/
// why/retryable/action), built from one catalog; technical detail never leaks
// into the primary message; classification uses structured signals only.
import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { AUTOMATION_ERROR_CATALOG, AUTOMATION_STAGE_LABELS, classifyThrownError, makeAutomationError, summarizeAutomationError, type AutomationErrorCode } from '../apps/desktop/src/sandbox/types/automationError'
import { failureFromRunnerDone } from '../apps/desktop/electron/sandbox/engine/failures'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() } }))

const ALL_CODES = Object.keys(AUTOMATION_ERROR_CATALOG) as AutomationErrorCode[]

describe('error catalog', () => {
  it('every code yields a non-empty message, a known stage, and (except INTERNAL) an actionable next step', () => {
    for (const code of ALL_CODES) {
      const e = makeAutomationError(code, { sku: 'SKU1', productType: 'ring', stageDetail: 'compressorNew' })
      expect(e.code).toBe(code)
      expect(e.message.length).toBeGreaterThan(10)
      expect(AUTOMATION_STAGE_LABELS[e.stage]).toBeTruthy()
      expect(typeof e.retryable).toBe('boolean')
      expect(e.action, `${code} needs an action`).toBeTruthy()
    }
  })

  it('covers every failure family the engine reports (input, preprocessing, AI, editing, post-processing, filesystem, run)', () => {
    const stages = new Set(ALL_CODES.map(c => makeAutomationError(c).stage))
    for (const s of ['input', 'preprocessing', 'ai_detection', 'editing', 'post_processing', 'filesystem', 'preflight', 'run', 'configuration']) {
      expect(stages.has(s as never), s).toBe(true)
    }
    // Every named failure from the spec has a code.
    for (const code of [
      'SOURCE_IMAGE_MISSING', 'SOURCE_IMAGE_UNREADABLE', 'SOURCE_IMAGE_UNSUPPORTED_FORMAT', 'SKU_MISSING', 'SKU_DUPLICATE', 'PRODUCT_TYPE_MISSING',
      'SOURCE_FOLDER_MISSING', 'METADATA_ROW_MISSING', 'METADATA_INVALID', 'MEASUREMENT_INVALID', 'MISSING_WATCH_MEASURE_BY', 'MISSING_WATCH_WIDTH',
      'MISSING_EARRING_CLASSIFICATION', 'MISSING_GEMSTONE_SHAPE', 'INVALID_GEMSTONE_DIMENSIONS', 'PRODUCT_PIPELINE_UNAVAILABLE', 'PYTHON_UNAVAILABLE',
      'PYTHON_DEPENDENCY_MISSING', 'BACKGROUND_REMOVAL_FAILED', 'UPSCALE_FAILED', 'TRIM_FAILED', 'ROTATE_FAILED', 'RESIZE_FAILED', 'WATCH_BOUNDARY_UNAVAILABLE',
      'WATCH_BOUNDARY_TIMEOUT', 'WATCH_BOUNDARY_HTTP_ERROR', 'WATCH_BOUNDARY_REJECTED', 'WATCH_BOUNDARY_INVALID', 'WATCH_BOUNDARY_MALFORMED_RESPONSE',
      'EDITING_RUNNER_FAILED', 'EDITING_LAUNCH_FAILED', 'EDITING_TIMEOUT', 'EDITING_MALFORMED_RESULT', 'EDITING_OUTPUT_MISSING', 'EDITING_OUTPUT_INVALID',
      'POSTPROCESSING_PYTHON_UNAVAILABLE', 'POSTPROCESSING_DEPENDENCY_MISSING', 'POSTPROCESSING_SCRIPT_MISSING', 'POSTPROCESSING_LAUNCH_FAILED',
      'POSTPROCESSING_NONZERO_EXIT', 'POSTPROCESSING_MALFORMED_RESULT', 'POSTPROCESSING_OUTPUT_MISSING', 'POSTPROCESSING_OUTPUT_INVALID',
      'POSTPROCESSING_PATH_FAILURE', 'POSTPROCESSING_CAPABILITY_UNAVAILABLE', 'WORKSPACE_CREATE_FAILED', 'PERMISSION_DENIED', 'SOURCE_DISAPPEARED',
      'DESTINATION_UNAVAILABLE', 'DISK_WRITE_FAILED', 'UNSAFE_PATH', 'RUN_INTERRUPTED',
    ]) {
      expect(ALL_CODES, code).toContain(code)
    }
  })

  it('matches the spec examples: message, action and retryable', () => {
    const watch = makeAutomationError('WATCH_BOUNDARY_UNAVAILABLE')
    expect(watch).toMatchObject({ stage: 'ai_detection', message: 'Watch boundary detection is currently unavailable.', action: 'Check the Watch AI service connection and retry.', retryable: true })
    const missing = makeAutomationError('MISSING_WATCH_WIDTH', { sku: 'ABC123' })
    expect(missing.message).toBe('Watch measurement data is missing for SKU ABC123.')
    expect(missing.retryable).toBe(false)
    const output = makeAutomationError('POSTPROCESSING_OUTPUT_MISSING', { stageDetail: 'compressorNew' })
    expect(output.message).toBe('compressorNew completed, but the expected output artifact was not created.')
    expect(output.retryable).toBe(true)
  })

  it('retryable vs non-retryable: missing input data needs a fix; transient/runtime problems are retryable', () => {
    for (const code of ['MISSING_WATCH_MEASURE_BY', 'MISSING_WATCH_WIDTH', 'MISSING_EARRING_CLASSIFICATION', 'MISSING_GEMSTONE_SHAPE', 'INVALID_GEMSTONE_DIMENSIONS', 'SOURCE_IMAGE_UNREADABLE', 'SKU_DUPLICATE', 'UNSAFE_PATH', 'WATCH_BOUNDARY_REJECTED'] as const) {
      expect(makeAutomationError(code).retryable, code).toBe(false)
    }
    for (const code of ['PYTHON_UNAVAILABLE', 'WATCH_BOUNDARY_UNAVAILABLE', 'WATCH_BOUNDARY_TIMEOUT', 'POSTPROCESSING_NONZERO_EXIT', 'DISK_WRITE_FAILED', 'RUN_INTERRUPTED', 'SOURCE_IMAGE_MISSING'] as const) {
      expect(makeAutomationError(code).retryable, code).toBe(true)
    }
  })

  it('technical detail stays in technicalMessage/cause (truncated) and never in the primary message', () => {
    const raw = 'Traceback (most recent call last):\n  File "x.py", line 3\nValueError: boom'
    const e = makeAutomationError('POSTPROCESSING_NONZERO_EXIT', { stageDetail: 'compressorNew', technicalMessage: raw + 'x'.repeat(5000) })
    expect(e.message).not.toContain('Traceback')
    expect(e.technicalMessage).toContain('ValueError: boom')
    expect(e.technicalMessage!.length).toBeLessThanOrEqual(2000)
    expect(summarizeAutomationError(e)).toBe(`compressorNew: ${e.message}`)
  })
})

describe('classifyThrownError — errno codes, never message text', () => {
  const err = (code: string, message = 'whatever') => Object.assign(new Error(message), { code })
  it.each([
    ['EACCES', 'PERMISSION_DENIED'], ['EPERM', 'PERMISSION_DENIED'], ['ENOENT', 'SOURCE_DISAPPEARED'], ['ENOSPC', 'DISK_WRITE_FAILED'],
    ['EROFS', 'DESTINATION_UNAVAILABLE'], ['ENAMETOOLONG', 'UNSAFE_PATH'],
  ] as const)('%s -> %s', (errno, code) => {
    const e = classifyThrownError(err(errno), { sku: 'S1' })
    expect(e.code).toBe(code)
    expect(e.cause).toBe(errno)
  })
  it('an unrecognized error is INTERNAL_ERROR with the real message kept as technical detail', () => {
    const e = classifyThrownError(new Error('kaboom'))
    expect(e.code).toBe('INTERNAL_ERROR')
    expect(e.technicalMessage).toBe('kaboom')
    // A message that merely LOOKS like a permission error is not interpreted.
    expect(classifyThrownError(new Error('EACCES: permission denied')).code).toBe('INTERNAL_ERROR')
  })
})

describe('failureFromRunnerDone — structured runner completion signals', () => {
  const base = { succeeded: 0, failed: 0 }
  it('a normal completion (>=1 success) is not a product-level failure', () => {
    expect(failureFromRunnerDone({ ...base, succeeded: 3, failed: 1 }, { stage: 'editing', productType: 'ring' })).toBeNull()
  })
  it('spawn failure vs timeout are distinguished structurally, per stage', () => {
    expect(failureFromRunnerDone({ ...base, spawnError: 'x', failureKind: 'spawn' }, { stage: 'editing', productType: 'ring' })?.code).toBe('EDITING_LAUNCH_FAILED')
    expect(failureFromRunnerDone({ ...base, spawnError: 'x', failureKind: 'timeout' }, { stage: 'editing', productType: 'ring' })?.code).toBe('EDITING_TIMEOUT')
    expect(failureFromRunnerDone({ ...base, spawnError: 'x', failureKind: 'spawn' }, { stage: 'preprocessing', productType: 'ring' })?.code).toBe('PREPROCESSING_START_FAILED')
  })
  it('a missing Python package is recognized from the exception class, everything else is a runner failure', () => {
    const dep = failureFromRunnerDone({ ...base, fatalError: "ModuleNotFoundError: No module named 'torch'" }, { stage: 'preprocessing', productType: 'ring' })
    expect(dep?.code).toBe('PYTHON_DEPENDENCY_MISSING')
    expect(dep?.message).toContain('torch')
    expect(failureFromRunnerDone({ ...base, fatalError: 'boom' }, { stage: 'editing', productType: 'ring' })?.code).toBe('EDITING_RUNNER_FAILED')
  })
  it('all-images-failed, and a job that processed nothing, are distinct failures; cancellation is not a failure', () => {
    expect(failureFromRunnerDone({ ...base, failed: 4 }, { stage: 'editing', productType: 'ring' })?.code).toBe('EDITING_RUNNER_FAILED')
    expect(failureFromRunnerDone({ ...base }, { stage: 'editing', productType: 'ring' })?.code).toBe('EDITING_OUTPUT_MISSING')
    expect(failureFromRunnerDone({ ...base, cancelledByUser: true }, { stage: 'editing', productType: 'ring' })).toBeNull()
  })
})
