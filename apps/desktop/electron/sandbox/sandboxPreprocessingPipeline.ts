// Sandbox Preprocessing execution (Phase 15.3) — runs the Phase 15.2
// SandboxPreprocessingConfig for one product type's already-materialized
// source folder (see sandboxWorkspace.ts). Reuses, never reimplements:
//   - the real Preprocessing subprocess runner, via ProcessingBackend
//     (electron/sandbox/processingBackend.ts), for background_removal/
//     upscale/both
//   - the Sandbox-only lightweight-copy None operation (Phase 15.1,
//     sandboxNonePreprocessing.ts) for 'none'
//   - the shared Rotation operation (Phase 15.1, imageRotation.ts) for
//     rotate
//   - workflowPreparation.ts's exported computeAlphaBoundingBox for trim
//     (the exact algorithm Legacy's own prepareForEditingHandoff uses)
// Legacy's own preprocessing semantics are completely untouched — nothing
// here calls into or modifies preprocessHandlers.ts/workflowPreparation.ts
// beyond the one already-exported pure helper above.
import { mkdir, readdir, copyFile, rename, unlink } from 'node:fs/promises'
import { join, extname } from 'node:path'
import sharp from 'sharp'
import { localProcessingBackend } from './processingBackend'
import { runSandboxNonePreprocessing } from './sandboxNonePreprocessing'
import { rotateImage } from '../services/imageRotation'
import { computeAlphaBoundingBox, mapWithConcurrency } from '../services/workflowPreparation'
import { observeJobEvents, waitForJobDone } from './waitForJobDone'
import { failureFromRunnerDone } from './engine/failures'
import { makeAutomationError, summarizeAutomationError, type AutomationError } from '../../src/sandbox/types/automationError'
import type { CancelHooks, ProductReporter } from './engine/progress'
import { sandboxSourceDir, sandboxPreprocessedDir, sandboxEditingInputDir } from './sandboxWorkspace'
import type { SingleFlightQueue } from '../services/singleFlightQueue'
import type { SandboxProductType } from '../../src/sandbox/types/sandboxProduct'
import type { SandboxPreprocessingConfig, SandboxPreprocessOperationChoice } from '../../src/sandbox/types/sandboxUniversalConfig'
import type { PreprocessOperation, PreprocessDonePayload } from '../../src/types/ipc'

const SUPPORTED_EXTENSIONS = new Set(['.png', '.webp'])

// Same bound prepareForEditingHandoff itself uses for the identical class
// of work (raw pixel buffers per in-flight image) — see
// workflowPreparation.ts's own mapWithConcurrency doc comment.
const TRIM_ROTATE_RESIZE_CONCURRENCY = 3

export interface SandboxPreprocessingStepResult {
  ok: boolean
  outputDir: string
  error?: string
  // Structured form of a product-level failure.
  failure?: AutomationError
  // Images that failed individually while others carried on (already
  // reported live through the reporter, listed here for direct callers).
  imageFailures?: { file: string; failure: AutomationError }[]
}

// The UBG runner's per-image sub-stages, mapped onto the plan's stage ids.
// birefnet/sam/plugin are all part of Background Removal; 'save' ends it.
const UBG_STAGE_TO_PLAN: Record<string, string> = {
  upscale: 'upscale',
  birefnet: 'background_removal',
  sam: 'background_removal',
  plugin: 'background_removal',
}

function stem(file: string): string {
  const ext = extname(file)
  return ext ? file.slice(0, -ext.length) : file
}

function mapOperation(choice: Exclude<SandboxPreprocessOperationChoice, 'none'>): PreprocessOperation[] {
  if (choice === 'both') return ['background_removal', 'upscale']
  if (choice === 'background_removal') return ['background_removal']
  return ['upscale']
}

// Applies trim/rotate/resize, in that order, to every image in sourceDir,
// writing the result to destDir — the exact same order and semantics as
// the existing optional mini-configuration (workflowPreparation.ts's
// prepareForEditingHandoff: trim, then rotate, then resize last so it
// normalizes the final oriented image). Per-file failures are recorded,
// not thrown — mirrors prepareForEditingHandoff's own error-tolerance
// model (a bad image doesn't abort the whole product's preprocessing).
async function applyTrimRotateResize(
  sourceDir: string,
  destDir: string,
  config: SandboxPreprocessingConfig,
  onStage?: (fileName: string, stageId: string, status: 'running' | 'done') => void,
): Promise<{ ok: boolean; total: number; failures: { file: string; stageId: string; error: unknown }[] }> {
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const names = entries
    .filter(e => e.isFile() && !e.name.startsWith('._') && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map(e => e.name)

  const failures: { file: string; stageId: string; error: unknown }[] = []

  await mapWithConcurrency(names, TRIM_ROTATE_RESIZE_CONCURRENCY, async name => {
    const inputPath = join(sourceDir, name)
    const outputPath = join(destDir, name)
    let stageId = 'trim'
    const begin = (id: string) => {
      stageId = id
      onStage?.(name, id, 'running')
    }
    const end = (id: string) => onStage?.(name, id, 'done')
    try {
      let workingPath = inputPath

      if (config.trim) {
        begin('trim')
        const bbox = await computeAlphaBoundingBox(inputPath)
        if (bbox === null) throw new Error('image has no non-transparent pixels')
        const trimmedPath = join(destDir, `.trim-${name}`)
        await sharp(inputPath).extract(bbox).toFile(trimmedPath)
        workingPath = trimmedPath
        end('trim')
      }

      if (config.rotate !== 0) {
        begin('rotate')
        const rotated = await rotateImage(workingPath, outputPath, config.rotate)
        if (!rotated.ok) throw new Error(rotated.error)
        end('rotate')
      } else if (workingPath !== outputPath) {
        await copyFile(workingPath, outputPath)
      }

      if (workingPath !== inputPath) await unlink(workingPath).catch(() => {})

      if (config.resizeToHeight !== null) {
        begin('resize')
        const tmpPath = `${outputPath}.resize.tmp`
        await sharp(outputPath).resize({ height: config.resizeToHeight }).toFile(tmpPath)
        await rename(tmpPath, outputPath)
        end('resize')
      }
    } catch (error) {
      // Never leave a partial output behind for a failed image — it must
      // not be picked up by Editing.
      await unlink(outputPath).catch(() => {})
      await unlink(join(destDir, `.trim-${name}`)).catch(() => {})
      failures.push({ file: name, stageId, error })
    }
  })

  // A product-level failure only when EVERY image failed; otherwise the
  // failed images are reported individually and the rest continue.
  return { ok: names.length > 0 && failures.length < names.length, total: names.length, failures }
}

const POST_STEP_CODES = { trim: 'TRIM_FAILED', rotate: 'ROTATE_FAILED', resize: 'RESIZE_FAILED' } as const

export async function runSandboxPreprocessingForProduct(params: {
  runId: string
  productType: SandboxProductType
  batchId: string
  config: SandboxPreprocessingConfig
  preprocessingDispatchQueue: SingleFlightQueue
  reporter?: ProductReporter
  cancelHooks?: CancelHooks
}): Promise<SandboxPreprocessingStepResult> {
  const { runId, productType, batchId, config, preprocessingDispatchQueue, reporter } = params
  const sourceDir = sandboxSourceDir(runId, productType)
  const preprocessedDir = sandboxPreprocessedDir(runId, productType)
  const fail = (failure: AutomationError, outputDir: string): SandboxPreprocessingStepResult => ({
    ok: false,
    outputDir,
    error: summarizeAutomationError(failure),
    failure,
  })

  if (config.operation === 'none') {
    const result = await runSandboxNonePreprocessing(sourceDir, preprocessedDir)
    if (!result.ok) {
      return fail(
        makeAutomationError('PREPROCESSING_INVALID_INPUT', { productType, technicalMessage: result.error ?? 'Sandbox None preprocessing failed' }),
        preprocessedDir,
      )
    }
  } else {
    // Preprocessing's underlying runner is one shared singleton
    // (electron/ipc/preprocessHandlers.ts) — only one job can be in flight
    // at a time, app-wide. When a SandboxRun has more than one product
    // needing real preprocessing, this queue orders their start calls
    // rather than letting the second one fail with "already running" (see
    // sandboxOrchestrator.ts's own doc comment on why this queue exists
    // and how it's unrelated to Watch's boundary-detection queue).
    const operations = mapOperation(config.operation)
    const dispatchResult = await preprocessingDispatchQueue.run(async () => {
      // Real per-image progress: the same NDJSON progress/complete/error
      // events the Legacy renderer's live view consumes (heartbeats are
      // deliberately ignored — they'd flood persistence).
      const running = new Map<string, string>()
      const observer = observeJobEvents('preprocess:event', event => {
        if (!reporter) return
        const file = event['image']
        const sku = typeof file === 'string' ? reporter.skuForFile(file) : null
        if (!sku) return
        if (event['type'] === 'progress') {
          const ubgStage = String(event['stage'] ?? '')
          if (ubgStage === 'save' && event['status'] === 'start') {
            reporter.stagesDone(sku, ['background_removal'], 'preprocessing')
            return
          }
          const planId = UBG_STAGE_TO_PLAN[ubgStage]
          if (!planId) return
          if (event['status'] === 'start') {
            running.set(sku, planId)
            reporter.stage(sku, planId, 'running')
          } else if (event['status'] === 'done' && planId === 'upscale') {
            reporter.stage(sku, 'upscale', 'done')
          }
        } else if (event['type'] === 'complete') {
          reporter.stagesDone(sku, ['upscale', 'background_removal'], 'preprocessing')
        } else if (event['type'] === 'error') {
          const at = running.get(sku)
          const code = at === 'upscale' ? 'UPSCALE_FAILED' : at === 'background_removal' ? 'BACKGROUND_REMOVAL_FAILED' : 'PREPROCESSING_FAILED'
          reporter.fail(sku, makeAutomationError(code, { productType, sku, technicalMessage: String(event['error'] ?? '') }), at)
        }
      })

      const start = await localProcessingBackend.preprocessing.start({
        inputDir: sourceDir,
        outputDir: preprocessedDir,
        operations,
        scaleFactor: operations.includes('upscale') ? config.upscaleFactor : 1,
        batchId,
      })
      if (!start.ok) {
        observer.stop()
        return { ok: false as const, error: start.error }
      }
      observer.setJobId(start.jobId)
      const unregister = params.cancelHooks?.register(() => void localProcessingBackend.preprocessing.cancel(start.jobId))
      try {
        const done = await waitForJobDone<PreprocessDonePayload>('preprocess:done', start.jobId)
        return { ok: true as const, done }
      } finally {
        unregister?.()
        observer.stop()
      }
    })

    if (!dispatchResult.ok) {
      return fail(makeAutomationError('PREPROCESSING_START_FAILED', { productType, technicalMessage: dispatchResult.error }), preprocessedDir)
    }
    const runnerFailure = failureFromRunnerDone(dispatchResult.done, { stage: 'preprocessing', productType })
    if (runnerFailure) return fail(runnerFailure, preprocessedDir)
  }

  const needsPostStep = config.trim || config.rotate !== 0 || config.resizeToHeight !== null
  if (!needsPostStep) {
    return { ok: true, outputDir: preprocessedDir }
  }

  const finalDir = sandboxEditingInputDir(runId, productType)
  const applied = await applyTrimRotateResize(preprocessedDir, finalDir, config, (file, stageId, status) => {
    const sku = reporter?.skuForFile(file)
    if (sku) reporter!.stage(sku, stageId, status)
  })

  const imageFailures = applied.failures.map(f => {
    const code = POST_STEP_CODES[f.stageId as keyof typeof POST_STEP_CODES] ?? 'PREPROCESSING_FAILED'
    const sku = reporter?.skuForFile(f.file) ?? undefined
    const failure = makeAutomationError(code, {
      productType,
      sku,
      technicalMessage: f.error instanceof Error ? f.error.message : String(f.error),
      cause: (f.error as { code?: string } | null)?.code,
    })
    if (sku) reporter!.fail(sku, failure, f.stageId)
    return { file: f.file, failure }
  })

  if (!applied.ok) {
    const first = imageFailures[0]?.failure
    return {
      ...fail(
        first ?? makeAutomationError('PREPROCESSING_INVALID_OUTPUT', { productType, technicalMessage: 'Trim/Rotate/Resize produced no images.' }),
        finalDir,
      ),
      imageFailures,
    }
  }
  return { ok: true, outputDir: finalDir, imageFailures }
}
