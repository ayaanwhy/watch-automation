// Sandbox product-specific Editing execution (Phase 15.3). Every product
// here reuses the existing real pipeline through the Phase 15.0
// ProcessingBackend abstraction (Ring/Bracelet/Watch) or, for Earring, the
// same underlying subprocess runner with a Sandbox-built sidecar in place
// of Legacy's metadata-spreadsheet resolution (see runSandboxEarringEditing's
// own doc comment for exactly why and what's different). No product's
// actual processing algorithm is reimplemented anywhere in this file.
import { engineTempDir } from './engine/runtime'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { localProcessingBackend } from './processingBackend'
import { runner as earringRawRunner } from '../ipc/earringHandlers'
import { writeShadowProfileSidecar } from '../services/shadowProfileDefinitions'
import { observeJobEvents, waitForJobDone } from './waitForJobDone'
import { failureFromRunnerDone, ringSegmentationFailure } from './engine/failures'
import { RING_SEGMENTATION_STAGE_ID } from './engine/stagePlan'
import { safeSegment, assertWithinDir } from './sandboxWorkspace'
import { getDetectionFailureInfo } from '../services/boundaryDetection'
import { makeAutomationError, summarizeAutomationError, type AutomationError, type AutomationErrorCode } from '../../src/sandbox/types/automationError'
import type { CancelHooks, ProductReporter } from './engine/progress'
import { updateStage } from '../services/batchRegistry'
import { countsFromImages } from '../services/subprocessProtocol'
import type { SingleFlightQueue } from '../services/singleFlightQueue'
import type { EarringType } from '../../src/constants/earringClassification'
import type { SandboxNormalizedProductItem } from '../../src/sandbox/types/sandboxProductData'
import { validateSandboxProductData } from '../../src/sandbox/lib/normalizeSandboxProductData'
import type { SandboxRunItemState } from '../../src/sandbox/types/sandboxRun'
import type { SandboxProductType } from '../../src/sandbox/types/sandboxProduct'
import type { RingBraceletDonePayload, EarringDonePayload } from '../../src/types/ipc'
import type { StageImageRecord } from '../../src/types/batch'
import { computeAlphaBoundingBox } from '../services/workflowPreparation'
import { detectBoundaries } from '../services/boundaryDetection'
import { loadBoundaryEndpoint } from '../services/boundaryEndpointPrefs'
import { runProcessWatch } from '../ipc/processHandlers'

export interface SandboxEditingStepResult {
  ok: boolean
  error?: string
  // Structured form of a product-level failure (automationError.ts).
  failure?: AutomationError
  items?: SandboxRunItemState[]
  cancelled?: boolean
  // SKUs the editing step positively reported as produced — anything the
  // orchestrator still considers active but is absent here never got a
  // result and is failed honestly rather than assumed successful.
  completedSkus?: string[]
}

function editingFailure(failure: AutomationError): SandboxEditingStepResult {
  return { ok: false, error: summarizeAutomationError(failure), failure }
}

// Live per-image progress for the subprocess-backed editors (Ring/Bracelet/
// Earring): their runners emit 'progress' (a stage starting), 'complete' and
// 'error' per image on the same NDJSON stream Legacy's renderer consumes.
// The Ring runner additionally announces its `ring_segmentation` stage (the
// PixelForge-derived model) before the rest of Ring Editing ('shadow'), and
// tags segmentation failures with a stable [RING_SEGMENTATION_*] token.
function observeEditingRunner(
  channel: string,
  productType: SandboxProductType,
  reporter: ProductReporter | undefined,
  completed: Set<string>,
) {
  return observeJobEvents(channel, event => {
    const file = event['image']
    const sku = typeof file === 'string' ? (reporter?.skuForFile(file) ?? null) : null
    if (!sku) return
    if (event['type'] === 'progress' && event['status'] === 'start') {
      if (productType === 'ring' && event['stage'] === RING_SEGMENTATION_STAGE_ID) {
        reporter?.stage(sku, RING_SEGMENTATION_STAGE_ID, 'running')
      } else {
        // Any later stage means segmentation (if this product has one) is finished.
        if (productType === 'ring') reporter?.stagesDone(sku, [RING_SEGMENTATION_STAGE_ID], 'editing')
        reporter?.stage(sku, 'editing', 'running')
      }
    } else if (event['type'] === 'complete') {
      completed.add(sku)
      reporter?.stagesDone(sku, productType === 'ring' ? [RING_SEGMENTATION_STAGE_ID, 'editing'] : ['editing'], 'editing')
    } else if (event['type'] === 'error') {
      const text = String(event['error'] ?? '')
      const segmentation = productType === 'ring' ? ringSegmentationFailure(text, { sku }) : null
      reporter?.fail(sku, segmentation ?? makeAutomationError('EDITING_RUNNER_FAILED', { productType, sku, technicalMessage: text }), segmentation ? RING_SEGMENTATION_STAGE_ID : 'editing')
    }
  })
}

// Ring & Bracelet share one underlying subprocess runner instance (see
// processingBackend.ts's own comment) — a SandboxRun containing both would
// otherwise have its second start() call rejected outright ("already
// running") rather than queued. Reuses SingleFlightQueue generically for
// this ordering purpose; entirely unrelated to (and a separate instance
// from) Watch's boundary-detection queue.
export async function runSandboxRingOrBraceletEditing(params: {
  productType: 'ring' | 'bracelet'
  inputDir: string
  outputDir: string
  batchId: string
  dispatchQueue: SingleFlightQueue
  reporter?: ProductReporter
  cancelHooks?: CancelHooks
}): Promise<SandboxEditingStepResult> {
  const completed = new Set<string>()
  const dispatch = await params.dispatchQueue.run(async () => {
    const observer = observeEditingRunner('ring-bracelet:event', params.productType, params.reporter, completed)
    const start = await localProcessingBackend.ringBracelet.start({
      inputDir: params.inputDir,
      outputDir: params.outputDir,
      product: params.productType,
      batchId: params.batchId,
      processingMode: 'automatic',
    })
    if (!start.ok) {
      observer.stop()
      return { ok: false as const, error: start.error }
    }
    observer.setJobId(start.jobId)
    const unregister = params.cancelHooks?.register(() => void localProcessingBackend.ringBracelet.cancel(start.jobId))
    try {
      const done = await waitForJobDone<RingBraceletDonePayload>('ring-bracelet:done', start.jobId)
      return { ok: true as const, done }
    } finally {
      unregister?.()
      observer.stop()
    }
  })

  if (!dispatch.ok) {
    return editingFailure(makeAutomationError('EDITING_LAUNCH_FAILED', { productType: params.productType, technicalMessage: dispatch.error }))
  }
  const failure = failureFromRunnerDone(dispatch.done, { stage: 'editing', productType: params.productType })
  if (failure) return editingFailure(failure)
  return { ok: true, completedSkus: Array.from(completed) }
}

async function writeSandboxJsonSidecar(subdir: string, data: unknown): Promise<string> {
  const dir = join(engineTempDir(), subdir)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}.json`)
  await writeFile(filePath, JSON.stringify(data), 'utf-8')
  return filePath
}

// Earring's real Legacy entry point (startEarringJob, exposed via
// ProcessingBackend) resolves classification from a metadata spreadsheet —
// a Legacy-only concept Sandbox's Temporary Batch model doesn't have (no
// Input/Output/spreadsheet in Sandbox, per the approved Phase 15
// architecture). Rather than fabricate a spreadsheet, this calls the exact
// same underlying subprocess runner (earringHandlers.ts's exported
// `runner`, already the real Python pipeline) with a sidecar built
// directly from the Temporary Batch's own per-image earringType field
// (Phase 15.3's one addition to that contract — see
// sandboxTemporaryBatch.ts). Hoop items with no manual split get an empty
// splits sidecar, which is the runner's own existing, documented
// "no splits available" behavior (see earringHandlers.ts's
// resolveHoopSplits comment) — not a new behavior invented for Sandbox.
export async function runSandboxEarringEditing(params: {
  runId: string
  inputDir: string
  outputDir: string
  batchId: string
  items: SandboxNormalizedProductItem[]
  reporter?: ProductReporter
  cancelHooks?: CancelHooks
}): Promise<SandboxEditingStepResult> {
  // Classification comes from the one normalization boundary (Phase 15.5)
  // — no re-parsing of raw Temporary Batch data here. An item whose
  // classification is missing is simply left out of the sidecar; the
  // runner's own per-SKU "missing from sidecar" error path (see
  // earringHandlers.ts) reports that image's failure without this file
  // needing to duplicate that check.
  const sidecar: Record<string, EarringType> = {}
  for (const item of params.items) {
    if (item.measurement.kind === 'earring' && item.measurement.earringType) {
      sidecar[item.sku] = item.measurement.earringType
    }
  }
  if (Object.keys(sidecar).length === 0) {
    return editingFailure(makeAutomationError('MISSING_EARRING_CLASSIFICATION', { productType: 'earring', technicalMessage: 'No item in this batch has an earringType.' }))
  }

  let metadataSidecarPath: string
  let splitsSidecarPath: string
  let shadowProfileSidecarPath: string
  try {
    metadataSidecarPath = await writeSandboxJsonSidecar('wpa-sandbox-earring-metadata', sidecar)
    splitsSidecarPath = await writeSandboxJsonSidecar('wpa-sandbox-earring-splits', {})
    shadowProfileSidecarPath = await writeShadowProfileSidecar()
  } catch (err) {
    return editingFailure(makeAutomationError('WORKSPACE_CREATE_FAILED', { productType: 'earring', technicalMessage: `Failed to prepare Earring sidecars: ${String(err)}` }))
  }

  const completed = new Set<string>()
  const observer = observeEditingRunner('earring:event', 'earring', params.reporter, completed)
  const start = await earringRawRunner.start({
    inputDir: params.inputDir,
    outputDir: params.outputDir,
    batchId: params.batchId,
    // Labeled sentinel, not a real path — Sandbox has no spreadsheet;
    // classification came from the Temporary Batch directly (see above).
    metadataFilePath: `sandbox-run:${params.runId}`,
    metadataSidecarPath,
    splitsSidecarPath,
    shadowProfileSidecarPath,
  })
  if (!start.ok) {
    observer.stop()
    return editingFailure(makeAutomationError('EDITING_LAUNCH_FAILED', { productType: 'earring', technicalMessage: start.error }))
  }
  observer.setJobId(start.jobId)
  const unregister = params.cancelHooks?.register(() => void earringRawRunner.cancel(start.jobId))
  let done: EarringDonePayload
  try {
    done = await waitForJobDone<EarringDonePayload>('earring:done', start.jobId)
  } finally {
    unregister?.()
    observer.stop()
  }
  const failure = failureFromRunnerDone(done, { stage: 'editing', productType: 'earring' })
  if (failure) return editingFailure(failure)
  return { ok: true, completedSkus: Array.from(completed) }
}

// Watch has no subprocess/NDJSON pipeline — the orchestrator drives it
// directly, image by image, through the exact architecture Phase 15.0
// approved: boundary detection (main-process, single-flighted) -> the
// existing processWatch engine (electron/ipc/processHandlers.ts's
// runProcessWatch, unchanged). Sequential by construction (a plain
// for-loop, not Promise.all) — mirrors Legacy's own Watch queue
// (queueHandlers.ts's isProcessing gate), which also only ever processes
// one image at a time.
export async function runSandboxWatchEditing(params: {
  inputDir: string
  outputDir: string
  batchId: string
  items: SandboxNormalizedProductItem[]
  // Checked before each image (Phase 15.3's cancellation model: prevent
  // QUEUED work from starting, never interrupt work already in flight).
  // Defaults to "never cancelled" so callers that don't care about
  // cancellation (e.g. direct unit tests) don't need to pass one.
  isCancelled?: () => Promise<boolean>
  reporter?: ProductReporter
}): Promise<SandboxEditingStepResult> {
  const reporter = params.reporter
  const completedSkus: string[] = []
  const endpointOverride = await loadBoundaryEndpoint()
  const items: SandboxRunItemState[] = []
  const imageRecords: StageImageRecord[] = []
  const isCancelled = params.isCancelled ?? (async () => false)

  for (let index = 0; index < params.items.length; index++) {
    const item = params.items[index]

    if (await isCancelled()) {
      for (const remaining of params.items.slice(index)) {
        items.push({ sku: remaining.sku, productType: 'watch', status: 'cancelled', error: null })
        imageRecords.push({ name: remaining.sku, status: 'cancelled', outputPath: null, error: null, durationMs: null })
      }
      await updateStage(params.batchId, 'watch', {
        images: imageRecords,
        counts: countsFromImages(imageRecords, params.items.length),
      })
      break
    }

    // Validation (measureBy/widthMm presence) is decided once, in the
    // Phase 15.5 normalization boundary — this file no longer defaults or
    // re-checks either field itself.
    const validation = validateSandboxProductData(item)
    if (validation.level === 'invalid' || item.measurement.kind !== 'watch') {
      const issue = validation.issues[0]
      const failure = makeAutomationError((issue?.code as AutomationErrorCode | undefined) ?? 'METADATA_INVALID', {
        productType: 'watch',
        sku: item.sku,
        technicalMessage: validation.issues.map(i => i.message).join(' '),
      })
      const error = summarizeAutomationError(failure)
      reporter?.fail(item.sku, failure)
      items.push({ sku: item.sku, productType: 'watch', status: 'failed', error, failure })
      imageRecords.push({ name: item.sku, status: 'failed', outputPath: null, error, durationMs: null })
      continue
    }

    const { measureBy, widthMm } = item.measurement
    const inputPath = join(params.inputDir, `${item.sku}.png`)

    reporter?.stage(item.sku, 'ai_detection', 'running')
    const detection = await detectBoundaries(inputPath, measureBy!, endpointOverride)
    if (!detection.ok || !detection.spliceBoundaries) {
      const failure = watchDetectionFailure(item.sku, detection)
      const error = summarizeAutomationError(failure)
      reporter?.fail(item.sku, failure, 'ai_detection')
      items.push({ sku: item.sku, productType: 'watch', status: 'failed', error, failure })
      imageRecords.push({ name: item.sku, status: 'failed', outputPath: null, error, durationMs: null })
      continue
    }
    reporter?.stage(item.sku, 'ai_detection', 'done')
    reporter?.stage(item.sku, 'editing', 'running')

    const result = await runProcessWatch({
      inputFolder: params.inputDir,
      outputFolder: params.outputDir,
      sku: item.sku,
      spliceBoundaries: detection.spliceBoundaries,
      scaleBoundaries: detection.scaleBoundaries,
      widthMm: widthMm!,
    })

    if (result.ok) {
      completedSkus.push(item.sku)
      reporter?.stagesDone(item.sku, ['editing'], 'editing')
      items.push({ sku: item.sku, productType: 'watch', status: 'completed', error: null })
      imageRecords.push({ name: item.sku, status: 'completed', outputPath: result.outputPath ?? null, error: null, durationMs: null })
    } else {
      const failure = makeAutomationError('WATCH_PROCESSING_FAILED', { productType: 'watch', sku: item.sku, technicalMessage: result.error ?? undefined })
      reporter?.fail(item.sku, failure, 'editing')
      items.push({ sku: item.sku, productType: 'watch', status: 'failed', error: summarizeAutomationError(failure), failure })
      imageRecords.push({ name: item.sku, status: 'failed', outputPath: null, error: result.error ?? 'Watch processing failed', durationMs: null })
    }

    // Persisted after every image (Phase 11.5D's own convention, reused
    // here) so an interruption loses at most the one image in flight, not
    // the whole product's progress — into the real underlying Legacy
    // Batch this Watch pipeline is using, exactly like every other Watch
    // batch's stage record.
    await updateStage(params.batchId, 'watch', {
      images: imageRecords,
      counts: countsFromImages(imageRecords, params.items.length),
    })
  }

  const anySucceeded = items.some(i => i.status === 'completed')
  const anyFailed = items.some(i => i.status === 'failed')
  const anyCancelled = items.some(i => i.status === 'cancelled')
  if (anyFailed && !anySucceeded) {
    // Every attempted image failed — surface the first image's structured
    // failure as the product-level one.
    const first = items.find(i => i.status === 'failed')?.failure
    return { ok: false, items, cancelled: anyCancelled, completedSkus, ...(first ? { failure: first, error: summarizeAutomationError(first) } : {}) }
  }
  return { ok: anySucceeded || !anyFailed, items, cancelled: anyCancelled, completedSkus }
}

// Structured (never message-parsed) mapping from the detection result's
// side-channel classification to an AutomationError.
function watchDetectionFailure(sku: string, detection: Awaited<ReturnType<typeof detectBoundaries>>): AutomationError {
  const info = getDetectionFailureInfo(detection)
  const ctx = { productType: 'watch', sku, technicalMessage: detection.ok ? 'No splice boundaries returned.' : `${detection.error}${info?.httpStatus ? ` (HTTP ${info.httpStatus})` : ''}` }
  switch (info?.reason) {
    case 'image_unreadable':
      return makeAutomationError('WATCH_IMAGE_UNREADABLE', ctx)
    case 'network':
      return makeAutomationError('WATCH_BOUNDARY_UNAVAILABLE', ctx)
    case 'timeout':
      return makeAutomationError('WATCH_BOUNDARY_TIMEOUT', ctx)
    case 'http_error':
      return makeAutomationError('WATCH_BOUNDARY_HTTP_ERROR', ctx)
    case 'malformed_response':
      return makeAutomationError('WATCH_BOUNDARY_MALFORMED_RESPONSE', ctx)
    case 'implausible':
      return makeAutomationError('WATCH_BOUNDARY_INVALID', ctx)
    case 'no_detection':
      return makeAutomationError('WATCH_BOUNDARY_REJECTED', ctx)
    default:
      // No classification (e.g. a successful call that returned no splice):
      // "nothing detected", not an outage.
      return makeAutomationError(!detection.ok && detection.retryable ? 'WATCH_BOUNDARY_UNAVAILABLE' : 'WATCH_BOUNDARY_REJECTED', ctx)
  }
}

// Gemstone's Editing stage. Receives the background-removed preprocessing
// output, trims each image to its alpha/content edges, and saves that exact
// trimmed result as the canonical `SKU;compare.png` (the same `;compare` tag
// Ring/Bracelet/Earring already use). The compare is the before/reference
// artifact: it is never modified after this point — resizeGems reads it and
// writes the separate `SKU;frontImage.png`. Recorded on the underlying Legacy
// Batch's editing stage like every other product (outputPath = the compare,
// assets.compare = the compare), so Final Review reads Gemstone through the
// same path. No visual editor is invented.
export async function runSandboxGemstoneEditing(params: {
  inputDir: string
  outputDir: string
  batchId: string
  items: SandboxNormalizedProductItem[]
  reporter?: ProductReporter
}): Promise<SandboxEditingStepResult> {
  const { reporter } = params
  await mkdir(params.outputDir, { recursive: true })
  const imageRecords: StageImageRecord[] = []
  const completedSkus: string[] = []
  const files = await readdir(params.inputDir).catch(() => [] as string[])

  for (const item of params.items) {
    const stem = safeSegment(item.sku)
    const source = files.find(f => !f.startsWith('.') && f.slice(0, f.lastIndexOf('.') > 0 ? f.lastIndexOf('.') : undefined) === stem)
    reporter?.stage(item.sku, 'editing', 'running')
    if (!source) {
      const failure = makeAutomationError('EDITING_OUTPUT_MISSING', { productType: 'gemstone', sku: item.sku, technicalMessage: 'No preprocessed image was found for this SKU.' })
      reporter?.fail(item.sku, failure, 'editing')
      imageRecords.push({ name: item.sku, status: 'failed', outputPath: null, error: summarizeAutomationError(failure), durationMs: null })
      continue
    }
    const comparePath = join(params.outputDir, `${stem};compare.png`)
    try {
      assertWithinDir(params.outputDir, comparePath)
      const started = Date.now()
      const bbox = await computeAlphaBoundingBox(join(params.inputDir, source))
      if (bbox === null) {
        const failure = makeAutomationError('EDITING_TRIM_FAILED', { productType: 'gemstone', sku: item.sku, technicalMessage: 'The image has no non-transparent pixels.' })
        reporter?.fail(item.sku, failure, 'editing')
        imageRecords.push({ name: item.sku, status: 'failed', outputPath: null, error: summarizeAutomationError(failure), durationMs: null })
        continue
      }
      await sharp(join(params.inputDir, source)).extract(bbox).png().toFile(comparePath)
      completedSkus.push(item.sku)
      reporter?.stagesDone(item.sku, ['editing'], 'editing')
      imageRecords.push({ name: item.sku, status: 'completed', outputPath: comparePath, assets: { compare: comparePath }, error: null, durationMs: Date.now() - started })
    } catch (err) {
      const failure = makeAutomationError('EDITING_OUTPUT_INVALID', { productType: 'gemstone', sku: item.sku, technicalMessage: err instanceof Error ? err.message : String(err) })
      reporter?.fail(item.sku, failure, 'editing')
      imageRecords.push({ name: item.sku, status: 'failed', outputPath: null, error: summarizeAutomationError(failure), durationMs: null })
    }
  }

  await updateStage(params.batchId, 'editing', {
    images: imageRecords,
    counts: countsFromImages(imageRecords, params.items.length),
  })

  if (completedSkus.length === 0) {
    const first = imageRecords.find(r => r.status === 'failed')
    return editingFailure(makeAutomationError('EDITING_OUTPUT_MISSING', { productType: 'gemstone', technicalMessage: first?.error ?? 'No Gemstone image could be trimmed and saved as compare.' }))
  }
  return { ok: true, completedSkus }
}
