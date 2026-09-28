// Automation job execution core (was the Sandbox Execution Orchestrator,
// Phase 15.3+). Turns a validated SandboxUniversalConfig + Temporary Batch
// into an executing pipeline:
//
//   input validation -> Preprocessing -> Product Editing -> Post Processing
//
// This file is the engine's job lifecycle (create / start / cancel /
// recover) plus the per-product pipeline. It has NO dependency on React, the
// Electron renderer, IPC or any window: progress leaves through the
// engine's event bus (engine/events.ts) and is persisted in the SandboxRun
// record (the single source of truth); Electron IPC, a future API adapter or
// a CLI are all just clients of that (see engine/automationEngine.ts and
// engine/README.md).
//
// Concurrency model (unchanged): different product types run concurrently
// (Promise.all below); within a product, stages are strictly sequential;
// Watch boundary detection funnels through the one authoritative
// boundaryDetection.ts queue — nothing here creates a second one.
//
// Failure model: every failure is an AutomationError (src/sandbox/types/
// automationError.ts) attached at the right level — the item, the product
// pipeline, or the run — never a bare string. Completed work is never
// relabelled by a later failure or by cancellation.
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { createBatch, getBatch, updateStage } from '../services/batchRegistry'
import { countsFromImages } from '../services/subprocessProtocol'
import { logger } from '../logger'
import { SingleFlightQueue } from '../services/singleFlightQueue'
import { createSandboxRun, getSandboxRun, listSandboxRuns, updateSandboxRun, type SandboxRunPatch } from './sandboxRunRegistry'
import { runSandboxRunPreflight } from './sandboxPreflight'
import {
  materializeProductImages,
  sandboxSourceDir,
  sandboxPreprocessedDir,
  sandboxEditingInputDir,
  sandboxEditingOutputDir,
  sandboxPostProcessingStageDir,
  safeSegment,
  UnsafePathError,
} from './sandboxWorkspace'
import { engineDataDir } from './engine/runtime'
import { sandboxPostProcessingAdapterRegistry } from './sandboxPostProcessing/registry'
import { resolveSelectedScripts } from '../../src/sandbox/types/sandboxPostProcessing'
import { runSandboxPreprocessingForProduct } from './sandboxPreprocessingPipeline'
import {
  runSandboxRingOrBraceletEditing,
  runSandboxEarringEditing,
  runSandboxWatchEditing,
  runSandboxGemstoneEditing,
  type SandboxEditingStepResult,
} from './sandboxEditingPipeline'
import { runSandboxPostProcessingForProduct } from './sandboxPostProcessing/sandboxPostProcessingRunner'
import { publishJobState } from './engine/events'
import { JobProgressRecorder, failItem, type CancelHooks, type ProductReporter } from './engine/progress'
import { planItemStages, preprocessingConfigFor } from './engine/stagePlan'
import { probeSourceImages } from './engine/sourceProbe'
import { sortSandboxProductTypes } from '../../src/sandbox/constants/productDisplay'
import { validateSandboxUniversalConfig } from '../../src/sandbox/types/sandboxUniversalConfig'
import { normalizeSandboxTemporaryBatch, validateSandboxProductData } from '../../src/sandbox/lib/normalizeSandboxProductData'
import {
  classifyThrownError,
  makeAutomationError,
  summarizeAutomationError,
  type AutomationError,
  type AutomationErrorCode,
} from '../../src/sandbox/types/automationError'
import type { SandboxTemporaryBatchDetail } from '../../src/sandbox/types/sandboxTemporaryBatch'
import type { SandboxUniversalConfig } from '../../src/sandbox/types/sandboxUniversalConfig'
import type { SandboxNormalizedProductItem, SandboxNormalizedTemporaryBatch } from '../../src/sandbox/types/sandboxProductData'
import type { SandboxProductType } from '../../src/sandbox/types/sandboxProduct'
import type { SandboxProductPipeline, SandboxRunDetail, SandboxRunItemState, SandboxRunStatus } from '../../src/sandbox/types/sandboxRun'
import type { StageImageRecord, StageType } from '../../src/types/batch'
import type { SandboxRestartBoundary } from '../../src/sandbox/types/sandboxRun'

// Dispatch-ordering queues (Phase 15.3), each scoped to a single underlying
// shared resource that already only permits one live job — SingleFlightQueue
// reused generically for ordering, entirely unrelated to Watch's queue:
//   - preprocessingDispatchQueue: Preprocessing's runner is one module-level
//     singleton (electron/ipc/preprocessHandlers.ts).
//   - ringBraceletDispatchQueue: Ring and Bracelet share one runner instance.
const preprocessingDispatchQueue = new SingleFlightQueue()
const ringBraceletDispatchQueue = new SingleFlightQueue()

// Serializes every read-modify-write against one SandboxRun's persisted
// record, per runId — product pipelines within a run update it concurrently
// and would otherwise lose writes. Every persisted update is also published
// on the engine event bus (full state), which is how clients stay live.
const runWriteQueues = new Map<string, Promise<void>>()

function queueRunUpdate(runId: string, mutate: (detail: SandboxRunDetail) => SandboxRunPatch): Promise<void> {
  const prior = (runWriteQueues.get(runId) ?? Promise.resolve()).catch(() => {})
  const next = prior.then(async () => {
    const detail = await getSandboxRun(runId)
    if (!detail) return
    const patch = mutate(detail)
    const updated = await updateSandboxRun(runId, patch)
    if (updated) publishJobState(updated)
  })
  runWriteQueues.set(runId, next)
  return next
}

type PipelinePatch = Partial<
  Pick<SandboxProductPipeline, 'status' | 'error' | 'stage' | 'batchId' | 'postProcessingOutputDir' | 'postProcessingArtifacts' | 'failure' | 'activity'>
>

async function updatePipeline(runId: string, productType: SandboxProductType, patch: PipelinePatch): Promise<void> {
  await queueRunUpdate(runId, detail => ({
    pipelines: detail.pipelines.map(p => (p.productType === productType ? { ...p, ...patch } : p)),
  }))
}

async function isCancelRequested(runId: string): Promise<boolean> {
  const detail = await getSandboxRun(runId)
  return detail?.cancelRequested ?? false
}

const itemKey = (productType: SandboxProductType, sku: string) => `${productType}:${sku}`

// ---- job creation ----------------------------------------------------------

export interface CreateJobResult {
  ok: boolean
  runId?: string
  error?: string
  failure?: AutomationError
}

export interface StartSandboxRunResult extends CreateJobResult {}

interface PendingJob {
  batch: SandboxTemporaryBatchDetail
  config: SandboxUniversalConfig
}
const pendingJobs = new Map<string, PendingJob>()
const activeJobs = new Set<string>()

function refuse(failure: AutomationError): CreateJobResult {
  return { ok: false, error: failure.message, failure }
}

// Input problems that make one item unprocessable — decided once, up front,
// from the normalized data and BEFORE anything runs, so the UI can show the
// plan (and the exact reason an item won't run) immediately. Never guessed
// or defaulted: an item missing a required input is failed with a precise,
// actionable reason.
export function collectInputFailures(normalized: SandboxNormalizedTemporaryBatch): Map<string, AutomationError> {
  const failures = new Map<string, AutomationError>()
  const seen = new Set<string>()
  for (const item of normalized.items) {
    if (!item.availability.available) continue
    const key = itemKey(item.productType, item.sku)
    if (seen.has(key.toLowerCase())) {
      failures.set(key, makeAutomationError('SKU_DUPLICATE', { productType: item.productType, sku: item.sku }))
      continue
    }
    seen.add(key.toLowerCase())
    const validation = validateSandboxProductData(item)
    if (validation.level === 'invalid') {
      const issue = validation.issues[0]
      failures.set(
        key,
        makeAutomationError((issue.code as AutomationErrorCode | undefined) ?? 'METADATA_INVALID', {
          productType: item.productType,
          sku: item.sku,
          technicalMessage: validation.issues.map(i => `${i.field}: ${i.message}`).join(' | '),
        }),
      )
    }
  }
  return failures
}

function initialItems(
  normalized: SandboxNormalizedTemporaryBatch,
  config: SandboxUniversalConfig,
  inputFailures: Map<string, AutomationError>,
): SandboxRunItemState[] {
  const now = new Date().toISOString()
  return normalized.items.map(item => {
    if (!item.availability.available) {
      return {
        sku: item.sku,
        productType: item.productType,
        status: 'unavailable' as const,
        error: item.availability.reason ?? 'No pipeline available for this product type yet.',
        failure: null,
        stages: [],
        stage: null,
      }
    }
    const state: SandboxRunItemState = {
      sku: item.sku,
      productType: item.productType,
      status: 'queued',
      error: null,
      failure: null,
      stages: planItemStages(item.productType, config),
      stage: null,
      startedAt: null,
      finishedAt: null,
    }
    const failure = inputFailures.get(itemKey(item.productType, item.sku))
    if (failure) failItem(state, failure, now)
    return state
  })
}

// Maps a failing preflight check to its structured cause by check id (never
// by message text).
function preflightFailure(checks: { id: string; label: string; detail: string }[]): AutomationError {
  const first = checks[0]
  const detail = checks.map(c => `${c.label}: ${c.detail}`).join('; ')
  const byId: Record<string, AutomationErrorCode> = {
    sandboxRunStorage: 'WORKSPACE_CREATE_FAILED',
    watchEndpointReachable: 'WATCH_BOUNDARY_UNAVAILABLE',
    postProcessingCapability: 'PYTHON_UNAVAILABLE',
    preprocessingRuntime: 'PYTHON_UNAVAILABLE',
    configurationValid: 'CONFIGURATION_INVALID',
  }
  const code = byId[first?.id ?? ''] ?? 'PREFLIGHT_FAILED'
  const failure = makeAutomationError(code, { technicalMessage: detail, detail: code === 'CONFIGURATION_INVALID' ? first.detail : undefined })
  // The legacy "Preflight failed — ..." wording is kept in `message`'s
  // technical companion; the headline is the specific cause.
  return { ...failure, technicalMessage: `Preflight failed — ${detail}` }
}

// createJob: validates, runs preflight, checks there is something runnable,
// and persists the job (status 'draft') with its full per-image plan. Nothing
// executes until startJob. If validation/preflight fails no job is created.
export async function createJob(batch: SandboxTemporaryBatchDetail, config: SandboxUniversalConfig): Promise<CreateJobResult> {
  const validation = validateSandboxUniversalConfig(config, batch)
  if (!validation.ok) {
    return refuse(makeAutomationError('CONFIGURATION_INVALID', { detail: validation.errors.join(' '), technicalMessage: validation.errors.join(' ') }))
  }

  const preflight = await runSandboxRunPreflight(batch, config)
  if (preflight.overall === 'fail') {
    const failing = preflight.checks.filter(c => c.status === 'fail')
    const failure = preflightFailure(failing)
    return { ok: false, error: `Preflight failed — ${failing.map(c => `${c.label}: ${c.detail}`).join('; ')}`, failure }
  }

  const normalized = normalizeSandboxTemporaryBatch(batch)
  const inputFailures = collectInputFailures(normalized)
  const runnable = normalized.items.filter(i => i.availability.available && !inputFailures.has(itemKey(i.productType, i.sku)))
  if (runnable.length === 0) {
    // Nothing could possibly run — report the first concrete input problem
    // (e.g. a missing Gemstone Shape) as the preflight error.
    const first = inputFailures.values().next().value as AutomationError | undefined
    return refuse(first ?? makeAutomationError('CONFIGURATION_INVALID', { detail: 'No processable items in this batch.' }))
  }

  const productTypes = sortSandboxProductTypes(batch.productTypes)
  let run: SandboxRunDetail
  try {
    run = await createSandboxRun({
      title: batch.name,
      temporaryBatchId: batch.id,
      productTypes,
      universalConfig: config as unknown as Record<string, unknown>,
    })
    await updateSandboxRun(run.id, { items: initialItems(normalized, config, inputFailures), inputItems: normalized.items })
  } catch (err) {
    return refuse(classifyThrownError(err, { technicalMessage: err instanceof Error ? err.message : String(err) }))
  }

  pendingJobs.set(run.id, { batch, config })
  return { ok: true, runId: run.id }
}

export async function startJob(runId: string): Promise<{ ok: boolean; error?: string; failure?: AutomationError }> {
  const pending = pendingJobs.get(runId)
  if (!pending) {
    const failure = makeAutomationError('CONFIGURATION_INVALID', { detail: 'This job was not created by this engine instance, or has already been started.' })
    return { ok: false, error: failure.message, failure }
  }
  pendingJobs.delete(runId)
  // Nothing may escape as an unhandled rejection: an unexpected engine error
  // is recorded on the job as a structured failure (technical detail kept in
  // the log and on the failure) instead of leaving it "running" forever.
  void executeJob(runId, pending.batch, pending.config).catch(async err => {
    logger.error(`automation-engine — job ${runId} crashed`, err)
    const failure = classifyThrownError(err)
    await queueRunUpdate(runId, () => ({ status: 'failed', failure, finishedAt: new Date().toISOString() })).catch(() => {})
  })
  return { ok: true }
}

// Convenience used by callers that create and immediately start a job (the
// Electron IPC handler today).
export async function startSandboxRun(batch: SandboxTemporaryBatchDetail, config: SandboxUniversalConfig): Promise<StartSandboxRunResult> {
  const created = await createJob(batch, config)
  if (!created.ok || !created.runId) return created
  const started = await startJob(created.runId)
  return started.ok ? { ok: true, runId: created.runId } : { ok: false, error: started.error, failure: started.failure, runId: created.runId }
}

// In-memory: which runs have had cancellation requested, and the cancel
// hooks of the subprocess jobs currently in flight for each.
const cancelRequestedRuns = new Set<string>()
const cancelHookSets = new Map<string, Set<() => void>>()

function cancelHooksFor(runId: string): CancelHooks {
  return {
    register(cancel) {
      const set = cancelHookSets.get(runId) ?? new Set<() => void>()
      cancelHookSets.set(runId, set)
      set.add(cancel)
      if (cancelRequestedRuns.has(runId)) cancel()
      return () => set.delete(cancel)
    },
  }
}

// Cooperative: sets the persisted flag (queued work never starts) AND asks
// every in-flight subprocess job to stop at its next safe checkpoint.
// In-flight work already past that point finishes; completed work is never
// relabelled. Post-processing scripts are short batch subprocesses with no
// safe interruption point — they finish, and the pipeline is cancelled at
// the next boundary.
export async function cancelSandboxRun(runId: string): Promise<{ ok: boolean }> {
  const existing = await getSandboxRun(runId)
  if (!existing) return { ok: false }
  cancelRequestedRuns.add(runId)
  await queueRunUpdate(runId, () => ({ cancelRequested: true }))
  for (const hook of cancelHookSets.get(runId) ?? []) hook()
  return { ok: true }
}

// A job persisted as in-flight whose engine process no longer exists can
// never make progress again (execution state lives in memory). Called once at
// startup: such jobs are recorded truthfully as interrupted — never left
// showing "running" forever, never silently resumed/duplicated.
export async function recoverInterruptedJobs(): Promise<string[]> {
  const recovered: string[] = []
  const RECENT_MS = 30 * 24 * 3600 * 1000
  for (const summary of await listSandboxRuns()) {
    if (['completed', 'partially_completed', 'failed', 'cancelled'].includes(summary.status)) {
      // A Retry Image in flight when the process died leaves ONE image
      // 'running' inside an otherwise finished run — record it as
      // interrupted (retryable again, its earlier failure kept in history).
      if (Date.now() - Date.parse(summary.updatedAt) > RECENT_MS) continue
      const detail = await getSandboxRun(summary.id)
      if (!detail?.items.some(i => i.status === 'running' || i.status === 'queued')) continue
      if ([...retrying].some(k => k.startsWith(`${summary.id}|`))) continue
      const at = new Date().toISOString()
      await queueRunUpdate(summary.id, d => {
        const items = structuredClone(d.items)
        for (const item of items) {
          if (item.status === 'running' || item.status === 'queued') failItem(item, { ...makeAutomationError('RUN_INTERRUPTED'), productType: item.productType, sku: item.sku }, at)
        }
        const patched = { ...d, items }
        const status = computeFinalStatus(patched)
        return { items, status, failure: status === 'failed' ? summarizeRunFailure(patched) : null }
      })
      recovered.push(summary.id)
      continue
    }
    if (!['draft', 'validating', 'running'].includes(summary.status)) continue
    if (activeJobs.has(summary.id) || pendingJobs.has(summary.id)) continue
    const now = new Date().toISOString()
    const neverStarted = summary.status === 'draft'
    const failure = makeAutomationError('RUN_INTERRUPTED')
    await queueRunUpdate(summary.id, detail => {
      const items = structuredClone(detail.items)
      for (const item of items) {
        if (neverStarted) {
          if (item.status === 'queued' || item.status === 'running') {
            item.status = 'cancelled'
            item.finishedAt = now
          }
        } else {
          failItem(item, { ...failure, productType: item.productType, sku: item.sku }, now)
        }
      }
      return {
        status: neverStarted ? 'cancelled' : 'failed',
        failure: neverStarted ? null : failure,
        finishedAt: now,
        items,
        pipelines: detail.pipelines.map(p =>
          p.status === 'running' || p.status === 'queued'
            ? { ...p, status: neverStarted ? 'cancelled' : 'failed', error: neverStarted ? null : failure.message, failure: neverStarted ? null : { ...failure, productType: p.productType }, activity: null }
            : p,
        ),
      }
    })
    recovered.push(summary.id)
  }
  return recovered
}

// ---- execution -------------------------------------------------------------

interface JobContext {
  runId: string
  batch: SandboxTemporaryBatchDetail
  normalizedBatch: SandboxNormalizedTemporaryBatch
  config: SandboxUniversalConfig
  recorder: JobProgressRecorder
  inputFailures: Map<string, AutomationError>
}

async function executeJob(runId: string, batch: SandboxTemporaryBatchDetail, config: SandboxUniversalConfig): Promise<void> {
  activeJobs.add(runId)
  try {
    await queueRunUpdate(runId, () => ({ status: 'running', startedAt: new Date().toISOString() }))

    const initialDetail = await getSandboxRun(runId)
    if (!initialDetail) return
    const availableProductTypes = initialDetail.pipelines.filter(p => p.status !== 'unavailable').map(p => p.productType)

    // Normalized exactly once per run (Phase 15.5) — every downstream step
    // consumes this same normalized batch, never re-parsing batch.images.
    const normalizedBatch = normalizeSandboxTemporaryBatch(batch)
    const recorder = new JobProgressRecorder(mutate => queueRunUpdate(runId, mutate))
    const ctx: JobContext = { runId, batch, normalizedBatch, config, recorder, inputFailures: collectInputFailures(normalizedBatch) }

    await Promise.all(availableProductTypes.map(productType => runProductPipelineGuarded(ctx, productType)))
    await recorder.flush()

    const final = await getSandboxRun(runId)
    if (!final) return
    const status = computeFinalStatus(final)
    await queueRunUpdate(runId, detail => ({
      status,
      finishedAt: new Date().toISOString(),
      failure: status === 'failed' ? summarizeRunFailure(detail) : null,
    }))
  } finally {
    activeJobs.delete(runId)
    cancelRequestedRuns.delete(runId)
    cancelHookSets.delete(runId)
  }
}

function summarizeRunFailure(detail: SandboxRunDetail): AutomationError {
  const first = detail.pipelines.find(p => p.status === 'failed' && p.failure)?.failure
  return first ?? makeAutomationError('INTERNAL_ERROR', { technicalMessage: 'The run failed without a recorded cause.' })
}

function computeFinalStatus(detail: SandboxRunDetail): SandboxRunStatus {
  if (detail.cancelRequested && detail.pipelines.some(p => p.status === 'cancelled')) {
    return detail.pipelines.some(p => p.status === 'completed') ? 'partially_completed' : 'cancelled'
  }
  const relevant = detail.pipelines.filter(p => p.status !== 'unavailable')
  if (relevant.length === 0) return 'failed' // every product type was unavailable
  const anyItemFailed = detail.items.some(i => i.status === 'failed')
  if (relevant.every(p => p.status === 'completed')) return anyItemFailed ? 'partially_completed' : 'completed'
  if (relevant.some(p => p.status === 'completed')) return 'partially_completed'
  return 'failed'
}

// A throw inside a product pipeline (mkdir EACCES, a registry write failing,
// ...) must never leave the run stuck at "running": it becomes that
// pipeline's structured failure and the other products carry on.
async function runProductPipelineGuarded(ctx: JobContext, productType: SandboxProductType): Promise<void> {
  try {
    await runProductPipeline(ctx, productType)
  } catch (err) {
    const failure = { ...classifyThrownError(err), productType }
    ctx.recorder.failAllActive(productType, failure)
    await ctx.recorder.flush()
    await updatePipeline(ctx.runId, productType, { status: 'failed', error: summarizeAutomationError(failure), failure, activity: null })
  }
}

function makeReporter(
  recorder: JobProgressRecorder,
  productType: SandboxProductType,
  items: SandboxNormalizedProductItem[],
  alive: Set<string>,
  failures: Map<string, AutomationError>,
): ProductReporter {
  const stemToSku = new Map(items.map(i => [safeSegment(i.sku).toLowerCase(), i.sku]))
  return {
    stage: (sku, stageId, status) => recorder.stage(productType, sku, stageId, status),
    stagesDone: (sku, ids, phase) => recorder.stagesDone(productType, sku, ids, phase),
    fail: (sku, failure, stageId) => {
      if (!alive.has(sku)) return
      alive.delete(sku)
      const withSku = { ...failure, productType, sku }
      failures.set(sku, withSku)
      recorder.fail(productType, sku, withSku, stageId)
    },
    skuForFile: file => {
      const dot = file.lastIndexOf('.')
      return stemToSku.get((dot > 0 ? file.slice(0, dot) : file).toLowerCase()) ?? null
    },
  }
}

// Product-specific Editing dispatch — the ONE place a product type maps to
// its editing implementation, used by both the whole-product pipeline and a
// single-image retry (so a retry goes through the same runners, queues and
// SingleFlight rules as a normal run).
async function dispatchEditing(p: {
  runId: string
  productType: SandboxProductType
  inputDir: string
  outputDir: string
  batchId: string
  items: SandboxNormalizedProductItem[]
  reporter: ProductReporter
}): Promise<SandboxEditingStepResult> {
  const { runId, productType, reporter } = p
  const common = { inputDir: p.inputDir, outputDir: p.outputDir, batchId: p.batchId, reporter }
  if (productType === 'ring' || productType === 'bracelet') {
    return runSandboxRingOrBraceletEditing({ ...common, productType, dispatchQueue: ringBraceletDispatchQueue, cancelHooks: cancelHooksFor(runId) })
  }
  if (productType === 'earring') {
    return runSandboxEarringEditing({ ...common, runId, items: p.items, cancelHooks: cancelHooksFor(runId) })
  }
  if (productType === 'gemstone') return runSandboxGemstoneEditing({ ...common, items: p.items })
  return runSandboxWatchEditing({ ...common, items: p.items, isCancelled: () => isCancelRequested(runId) })
}

async function runProductPipeline(ctx: JobContext, productType: SandboxProductType): Promise<void> {
  const { runId, batch, normalizedBatch, config, recorder, inputFailures } = ctx

  const settle = async (patch: PipelinePatch) => {
    await recorder.flush()
    await updatePipeline(runId, productType, { activity: null, ...patch })
  }
  const failPipeline = async (failure: AutomationError) => {
    const f = { ...failure, productType }
    recorder.failAllActive(productType, f)
    await settle({ status: 'failed', error: summarizeAutomationError(f), failure: f })
  }
  const cancelPipeline = async () => {
    recorder.cancelAllActive(productType)
    await settle({ status: 'cancelled', error: null, failure: null })
  }

  if (await isCancelRequested(runId)) return cancelPipeline()

  const productItems = normalizedBatch.items.filter(i => i.productType === productType)
  const runnable = productItems.filter(i => !inputFailures.has(itemKey(productType, i.sku)))
  if (productItems.length === 0) {
    return failPipeline(makeAutomationError('METADATA_INVALID', { productType, technicalMessage: 'No images for this product type in the selected batch.' }))
  }
  if (runnable.length === 0) {
    const first = inputFailures.get(itemKey(productType, productItems[0].sku))
    return failPipeline(first ?? makeAutomationError('METADATA_INVALID', { productType }))
  }

  const alive = new Set(runnable.map(i => i.sku))
  const failures = new Map<string, AutomationError>()
  const reporter = makeReporter(recorder, productType, runnable, alive, failures)
  const aliveItems = () => runnable.filter(i => alive.has(i.sku))
  const firstFailure = () => failures.values().next().value as AutomationError | undefined

  await updatePipeline(runId, productType, {
    status: 'running',
    stage: 'preprocessing',
    error: null,
    failure: null,
    activity: 'Preparing images',
  })

  // --- workspace + Legacy Batch (Option B grouping) ---
  const legacyPipeline: StageType[] = productType === 'watch' ? ['preprocessing', 'watch'] : ['preprocessing', 'editing']
  let legacyBatchId: string
  try {
    const legacyBatch = await createBatch({
      sourceDir: sandboxSourceDir(runId, productType),
      pipeline: legacyPipeline,
      title: `Sandbox — ${batch.name} — ${productType}`,
      mode: 'production',
    })
    legacyBatchId = legacyBatch.id
    await updatePipeline(runId, productType, { batchId: legacyBatch.id })
  } catch (err) {
    return failPipeline(makeAutomationError('WORKSPACE_CREATE_FAILED', { productType, technicalMessage: err instanceof Error ? err.message : String(err) }))
  }

  const materialized = await materializeProductImages(runId, productType, runnable)
  for (const { sku, cause } of materialized.failures) {
    const failure =
      cause instanceof UnsafePathError
        ? makeAutomationError('UNSAFE_PATH', { productType, sku, technicalMessage: cause.message })
        : (cause as { code?: string })?.code === 'ENOENT'
          ? makeAutomationError('SOURCE_IMAGE_MISSING', { productType, sku, technicalMessage: cause instanceof Error ? cause.message : String(cause) })
          : classifyThrownError(cause, { productType, sku })
    reporter.fail(sku, failure)
  }
  if (materialized.copiedCount === 0) {
    return failPipeline(firstFailure() ?? makeAutomationError('SOURCE_IMAGE_MISSING', { productType }))
  }

  // Corrupt / unsupported source images fail individually, before any
  // expensive processing starts.
  const probeFailures = await probeSourceImages(
    sandboxSourceDir(runId, productType),
    productType,
    new Map(aliveItems().map(i => [safeSegment(i.sku).toLowerCase(), i.sku])),
  )
  for (const { sku, failure } of probeFailures) reporter.fail(sku, failure)
  if (alive.size === 0) return failPipeline(firstFailure() ?? makeAutomationError('SOURCE_IMAGE_UNREADABLE', { productType }))

  if (await isCancelRequested(runId)) return cancelPipeline()

  // --- preprocessing ---
  await updatePipeline(runId, productType, { activity: 'Preprocessing' })
  const preprocessed = await runSandboxPreprocessingForProduct({
    runId,
    productType,
    batchId: legacyBatchId,
    config: preprocessingConfigFor(productType, config.preprocessing),
    preprocessingDispatchQueue,
    reporter,
    cancelHooks: cancelHooksFor(runId),
  })
  if (!preprocessed.ok) {
    return failPipeline(preprocessed.failure ?? makeAutomationError('PREPROCESSING_FAILED', { productType, technicalMessage: preprocessed.error }))
  }
  // A cancel that stopped preprocessing early leaves unprocessed images —
  // cancelled, not "preprocessing done".
  if (await isCancelRequested(runId)) return cancelPipeline()
  recorder.phaseDone(productType, 'preprocessing')
  if (alive.size === 0) return failPipeline(firstFailure() ?? makeAutomationError('PREPROCESSING_FAILED', { productType }))

  if (await isCancelRequested(runId)) return cancelPipeline()

  // --- editing ---
  await updatePipeline(runId, productType, { stage: 'editing', activity: 'Editing' })
  const editingOutputDir = sandboxEditingOutputDir(runId, productType)
  // Ring/Bracelet/Earring runners create their own --output-dir; Watch's
  // processWatch does not spawn a subprocess and needs it to exist.
  await mkdir(editingOutputDir, { recursive: true })

  const editing = await dispatchEditing({
    runId,
    productType,
    inputDir: preprocessed.outputDir,
    outputDir: editingOutputDir,
    batchId: legacyBatchId,
    items: aliveItems(),
    reporter,
  })

  if (editing.cancelled) {
    // Only images that had not finished are cancelled; completed/failed ones
    // keep their real state.
    return cancelPipeline()
  }
  if (!editing.ok) {
    return failPipeline(editing.failure ?? makeAutomationError('EDITING_RUNNER_FAILED', { productType, technicalMessage: editing.error }))
  }

  // A cancel that stopped the editing job early leaves images with no
  // result — those are cancelled, never reported as failures.
  if (await isCancelRequested(runId)) return cancelPipeline()

  // An image the editor never reported a result for is not assumed
  // successful — it is failed honestly.
  const reported = new Set(editing.completedSkus ?? [])
  for (const item of aliveItems()) {
    if (!reported.has(item.sku)) {
      reporter.fail(item.sku, makeAutomationError('EDITING_OUTPUT_MISSING', { productType, sku: item.sku, technicalMessage: 'The editing step reported no result for this image.' }), 'editing')
    }
  }
  if (alive.size === 0) return failPipeline(firstFailure() ?? makeAutomationError('EDITING_OUTPUT_MISSING', { productType }))

  if (await isCancelRequested(runId)) return cancelPipeline()

  // --- post-processing (batch-global scripts) ---
  await updatePipeline(runId, productType, { stage: 'post_processing', activity: 'Post-processing' })
  const postProcessed = await runSandboxPostProcessingForProduct({
    runId,
    productType,
    batchId: legacyBatchId,
    editingOutputDir,
    selection: config.postProcessingByProduct[productType] ?? {},
    isCancelled: () => isCancelRequested(runId),
    items: aliveItems(),
    onScript: ({ scriptId, status }) => {
      recorder.productStage(productType, `pp:${scriptId}`, status === 'running' ? 'running' : status === 'done' ? 'done' : 'failed')
      recorder.activity(productType, status === 'running' ? `Running ${scriptId} — batch post-processing` : null)
    },
  })

  if (postProcessed.cancelled) return cancelPipeline()
  if (!postProcessed.ok) {
    return failPipeline(
      postProcessed.failure ?? makeAutomationError('POSTPROCESSING_NONZERO_EXIT', { productType, stageDetail: postProcessed.failedScriptId, technicalMessage: postProcessed.error }),
    )
  }

  // Sandbox-owned record of WHERE the real final artifact landed (Final
  // Review resolves each image against it) — not a write to Legacy's schema.
  recorder.completeAllActive(productType)
  await settle({
    status: 'completed',
    error: null,
    failure: null,
    postProcessingOutputDir: postProcessed.outputDir,
    postProcessingArtifacts: postProcessed.artifacts,
  })
}

// ---- Retry Image -----------------------------------------------------------
//
// retryImage re-runs ONE failed image of an existing run through the same
// stages, runners, queues and SingleFlight rules as a normal run — never a
// separate execution path. It restarts from the boundary the image's own
// persisted stage state says it failed at (preprocessing / editing /
// post-processing), reusing the upstream artifacts that already exist, and
// works in an isolated per-attempt workspace (`<run>/retry/<sku>-<n>/`) so
// successful images can never be touched. Only on success are that image's
// artifacts merged into the product's real directories (overwriting only its
// own files) and its Legacy stage record upserted.

const retrying = new Set<string>()
const METADATA_FILE_NAMES = new Set(['dimensions.csv', 'measurements.xlsx'])
const TERMINAL_RUN_STATUSES = new Set<SandboxRunStatus>(['completed', 'partially_completed', 'failed', 'cancelled'])

// The SKU a file belongs to: the stem up to the first ';' tag (matching how
// Ring/Bracelet/Earring/Gemstone name their `SKU;tag.png` artifacts).
function skuOfFile(file: string): string {
  const stem = extname(file) ? file.slice(0, -extname(file).length) : file
  return stem.split(';')[0].toLowerCase()
}

async function skuFiles(dir: string, sku: string): Promise<string[]> {
  const want = safeSegment(sku).toLowerCase()
  return (await readdir(dir).catch(() => [] as string[])).filter(f => !f.startsWith('.') && skuOfFile(f) === want)
}

async function copySkuFiles(srcDir: string, destDir: string, sku: string): Promise<number> {
  await mkdir(destDir, { recursive: true })
  const files = await skuFiles(srcDir, sku)
  for (const f of files) await copyFile(join(srcDir, f), join(destDir, f))
  return files.length
}

// Where an image should restart, from its persisted per-stage state. If the
// upstream artifact it would need is gone, it falls back one boundary earlier
// rather than failing.
export async function determineRestartBoundary(runId: string, productType: SandboxProductType, item: SandboxRunItemState): Promise<SandboxRestartBoundary> {
  const failedStage = item.stages?.find(s => s.status === 'failed')
  let phase: SandboxRestartBoundary
  if (failedStage) phase = failedStage.phase
  else {
    const at = item.failure?.stage
    phase = at === 'ai_detection' || at === 'editing' ? 'editing' : at === 'post_processing' ? 'post_processing' : 'preprocessing'
  }
  if (phase === 'post_processing' && (await skuFiles(sandboxEditingOutputDir(runId, productType), item.sku)).length > 0) return 'post_processing'
  if (phase === 'post_processing') phase = 'editing'
  if (phase === 'editing') {
    const hasInput =
      (await skuFiles(sandboxEditingInputDir(runId, productType), item.sku)).length > 0 ||
      (await skuFiles(sandboxPreprocessedDir(runId, productType), item.sku)).length > 0
    if (hasInput) return 'editing'
  }
  return 'preprocessing'
}

function materializeFailure(cause: unknown, productType: SandboxProductType, sku: string): AutomationError {
  if (cause instanceof UnsafePathError) return makeAutomationError('UNSAFE_PATH', { productType, sku, technicalMessage: cause.message })
  if ((cause as { code?: string })?.code === 'ENOENT') {
    return makeAutomationError('SOURCE_IMAGE_MISSING', { productType, sku, technicalMessage: cause instanceof Error ? cause.message : String(cause) })
  }
  return classifyThrownError(cause, { productType, sku })
}

export interface RetryImageResult {
  ok: boolean
  error?: string
  failure?: AutomationError
}

export async function retryImage(runId: string, productType: SandboxProductType, sku: string): Promise<RetryImageResult> {
  const refuse = (detail: string): RetryImageResult => {
    const failure = makeAutomationError('RETRY_NOT_APPLICABLE', { productType, sku, detail })
    return { ok: false, error: failure.message, failure }
  }
  const run = await getSandboxRun(runId)
  if (!run) return refuse('the run was not found')
  const item = run.items.find(i => i.productType === productType && i.sku === sku)
  if (!item) return refuse('the image is not part of this run')
  if (item.status !== 'failed') return refuse('only a failed image can be retried')
  if (item.failure && item.failure.retryable === false) return refuse('its failure needs its input data fixed first')
  const key = `${runId}|${productType}|${sku}`
  if (retrying.has(key)) return refuse('it is already being retried')
  const pipeline = run.pipelines.find(p => p.productType === productType)
  if (!pipeline || ['running', 'queued', 'unavailable'].includes(pipeline.status)) return refuse('its product is still processing')
  if (run.cancelRequested && !TERMINAL_RUN_STATUSES.has(run.status)) return refuse('the run is being cancelled')
  const normalized = run.inputItems?.find(i => i.productType === productType && i.sku === sku)
  if (!normalized) return refuse('this run was created before retry was supported')

  // Claimed in the same synchronous stretch as the checks above: two
  // concurrent calls (a double click) can never both pass them.
  retrying.add(key)
  let boundary: SandboxRestartBoundary
  try {
    boundary = await determineRestartBoundary(runId, productType, item)
  } catch (err) {
    retrying.delete(key)
    throw err
  }
  const attempt = (item.attempt ?? 1) + 1
  if (TERMINAL_RUN_STATUSES.has(run.status)) cancelRequestedRuns.delete(runId) // new work after a finished run
  try {
    // Reset ONLY this image: keep earlier phases' completed stages, reset the
    // stages from the restart boundary on, record the failed attempt.
    await queueRunUpdate(runId, detail => {
      const items = structuredClone(detail.items)
      const it = items.find(i => i.productType === productType && i.sku === sku)!
      const order: SandboxRestartBoundary[] = ['preprocessing', 'editing', 'post_processing']
      const now = new Date().toISOString()
      it.history = [...(it.history ?? []), { attempt: it.attempt ?? 1, failure: it.failure ?? null, failedAt: it.finishedAt ?? null, restartedFrom: boundary }]
      it.attempt = attempt
      it.status = 'running'
      it.failure = null
      it.error = null
      it.stage = null
      it.startedAt = now
      it.finishedAt = null
      for (const stage of it.stages ?? []) if (order.indexOf(stage.phase) >= order.indexOf(boundary)) stage.status = 'pending'
      return { items, ...(TERMINAL_RUN_STATUSES.has(detail.status) ? { cancelRequested: false } : {}) }
    })
  } catch (err) {
    retrying.delete(key)
    throw err
  }

  void executeRetry({ runId, productType, item: normalized, boundary, attempt, config: run.universalConfig as unknown as SandboxUniversalConfig })
    .catch(async err => {
      logger.error(`automation-engine — retry of ${key} crashed`, err)
      const failure = { ...classifyThrownError(err), productType, sku }
      await queueRunUpdate(runId, detail => {
        const items = structuredClone(detail.items)
        const it = items.find(i => i.productType === productType && i.sku === sku)
        if (it) failItem(it, failure, new Date().toISOString())
        return withDerivedStatus(detail, { items })
      }).catch(() => {})
    })
    .finally(() => {
      retrying.delete(key)
      // No retry or job left for this run: forget any stale cancel state so a
      // LATER retry isn't cancelled on arrival.
      if (![...retrying].some(k => k.startsWith(`${runId}|`)) && !activeJobs.has(runId)) {
        cancelRequestedRuns.delete(runId)
        cancelHookSets.delete(runId)
      }
    })
  return { ok: true }
}

// A finished run stays terminal while one image is retried; only its status is
// re-derived — folded into the same write as the image's own state change.
function withDerivedStatus(detail: SandboxRunDetail, patch: Partial<SandboxRunDetail>): Partial<SandboxRunDetail> {
  if (!TERMINAL_RUN_STATUSES.has(detail.status)) return patch
  const merged = { ...detail, ...patch }
  const status = computeFinalStatus(merged)
  return { ...patch, status, failure: status === 'failed' ? summarizeRunFailure(merged) : null }
}

async function executeRetry(p: {
  runId: string
  productType: SandboxProductType
  item: SandboxNormalizedProductItem
  boundary: SandboxRestartBoundary
  attempt: number
  config: SandboxUniversalConfig
}): Promise<void> {
  const { runId, productType, item, boundary, attempt, config } = p
  const sku = item.sku
  const safe = safeSegment(sku)
  // The run's overall status is recomputed IN THE SAME WRITE as this image's
  // state changes, so a reader never sees a finished image beside a stale run
  // status (a finished run stays terminal; only its status is re-derived).
  const recorder = new JobProgressRecorder(m =>
    queueRunUpdate(runId, detail => withDerivedStatus(detail, m(detail))),
  )
  const alive = new Set([sku])
  const reporter = makeReporter(recorder, productType, [item], alive, new Map())
  const cancelHooks = cancelHooksFor(runId)

  const retryRoot = join(engineDataDir(), 'sandbox-runs', runId, 'retry')
  // Earlier attempts' scratch dirs for THIS sku only (`<sku>-<n>` and its
  // `-merge…` staging) — an exact match, so a sku that merely shares a prefix
  // ("A" vs "A-1") is never touched.
  const ownDir = new RegExp(`^${safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+(-merge.*)?$`)
  for (const d of await readdir(retryRoot).catch(() => [] as string[])) {
    if (ownDir.test(d)) await rm(join(retryRoot, d), { recursive: true, force: true })
  }
  const workspaceId = `${runId}/retry/${safe}-${attempt}`

  const endFailed = async (failure: AutomationError, stageId?: string) => {
    reporter.fail(sku, failure, stageId)
    await recorder.flush()
  }
  const endCancelled = async () => {
    recorder.cancelSku(productType, sku)
    await recorder.flush()
  }

  const run = await getSandboxRun(runId)
  if (!run) return
  const legacyStages: StageType[] = productType === 'watch' ? ['preprocessing', 'watch'] : ['preprocessing', 'editing']
  const retryBatch = await createBatch({
    sourceDir: sandboxSourceDir(workspaceId, productType),
    pipeline: legacyStages,
    title: `Sandbox retry — ${run.title} — ${productType} — ${sku}`,
    mode: 'production',
  })

  // --- preprocessing boundary: materialize the image again, then preprocess it ---
  let editingInput: string
  if (boundary === 'preprocessing') {
    const materialized = await materializeProductImages(workspaceId, productType, [item])
    if (materialized.failures.length > 0) return endFailed(materializeFailure(materialized.failures[0].cause, productType, sku))
    const probe = await probeSourceImages(sandboxSourceDir(workspaceId, productType), productType, new Map([[safe.toLowerCase(), sku]]))
    if (probe.length > 0) return endFailed(probe[0].failure)
    if (await isCancelRequested(runId)) return endCancelled()

    const pre = await runSandboxPreprocessingForProduct({
      runId: workspaceId,
      productType,
      batchId: retryBatch.id,
      config: preprocessingConfigFor(productType, config.preprocessing),
      preprocessingDispatchQueue,
      reporter,
      cancelHooks,
    })
    if (!pre.ok) return endFailed(pre.failure ?? makeAutomationError('PREPROCESSING_FAILED', { productType, sku, technicalMessage: pre.error }))
    if (!alive.has(sku)) return endFailed(makeAutomationError('PREPROCESSING_FAILED', { productType, sku })) // failed inside (already reported)
    if (await isCancelRequested(runId)) return endCancelled()
    recorder.phaseDone(productType, 'preprocessing', sku)
    editingInput = pre.outputDir
  } else {
    editingInput = sandboxPreprocessedDir(workspaceId, productType)
    if (boundary === 'editing') {
      const fromDir =
        (await skuFiles(sandboxEditingInputDir(runId, productType), sku)).length > 0
          ? sandboxEditingInputDir(runId, productType)
          : sandboxPreprocessedDir(runId, productType)
      await copySkuFiles(fromDir, editingInput, sku)
    }
  }

  // --- editing boundary ---
  const editingOutputDir = sandboxEditingOutputDir(workspaceId, productType)
  if (boundary !== 'post_processing') {
    await mkdir(editingOutputDir, { recursive: true })
    const editing = await dispatchEditing({
      runId,
      productType,
      inputDir: editingInput,
      outputDir: editingOutputDir,
      batchId: retryBatch.id,
      items: [item],
      reporter,
    })
    if (editing.cancelled) return endCancelled()
    if (!editing.ok) return endFailed(editing.failure ?? makeAutomationError('EDITING_RUNNER_FAILED', { productType, sku, technicalMessage: editing.error }), 'editing')
    if (await isCancelRequested(runId)) return endCancelled()
    if (!alive.has(sku) || !(editing.completedSkus ?? []).includes(sku)) {
      return endFailed(makeAutomationError('EDITING_OUTPUT_MISSING', { productType, sku, technicalMessage: 'The editing step reported no result for this image.' }), 'editing')
    }
  } else {
    await copySkuFiles(sandboxEditingOutputDir(runId, productType), editingOutputDir, sku)
  }

  // --- post-processing (a single-image chain in the retry workspace) ---
  const selection = config.postProcessingByProduct[productType] ?? {}
  const post = await runSandboxPostProcessingForProduct({
    runId: workspaceId,
    productType,
    batchId: retryBatch.id,
    editingOutputDir,
    selection,
    isCancelled: () => isCancelRequested(runId),
    items: [item],
    onScript: ({ scriptId, status }) => recorder.stage(productType, sku, `pp:${scriptId}`, status === 'running' ? 'running' : status === 'done' ? 'done' : 'failed'),
  })
  if (post.cancelled) return endCancelled()
  if (!post.ok) {
    return endFailed(post.failure ?? makeAutomationError('POSTPROCESSING_NONZERO_EXIT', { productType, sku, stageDetail: post.failedScriptId, technicalMessage: post.error }), post.failedScriptId ? `pp:${post.failedScriptId}` : undefined)
  }

  // --- commit: refresh product-level measurement artifacts over the merged
  // set (staged first, so a failure here merges nothing), then merge ---
  const origRun = (await getSandboxRun(runId))!
  const origPipeline = origRun.pipelines.find(pl => pl.productType === productType)!
  const lastScriptId = resolveSelectedScripts(productType, selection).at(-1)?.id ?? 'compressorNew'
  const finalDir = origPipeline.postProcessingOutputDir ?? sandboxPostProcessingStageDir(runId, productType, lastScriptId)
  await mkdir(finalDir, { recursive: true })

  const measurementScripts = resolveSelectedScripts(productType, selection).filter(s => s.id === 'autoMCFF' || s.id === 'autoMeasurementCalculator')
  const refreshed: { name: string; from: string }[] = []
  let artifacts = [...(origPipeline.postProcessingArtifacts ?? [])]
  if (measurementScripts.length > 0) {
    const stage = join(retryRoot, `${safe}-${attempt}-merge`)
    await mkdir(stage, { recursive: true })
    for (const f of await readdir(finalDir)) if (!f.startsWith('.')) await copyFile(join(finalDir, f), join(stage, f))
    for (const f of await readdir(post.outputDir)) if (!f.startsWith('.') && !METADATA_FILE_NAMES.has(f)) await copyFile(join(post.outputDir, f), join(stage, f))
    for (const script of measurementScripts) {
      const outDir = join(retryRoot, `${safe}-${attempt}-merge-${script.id}`)
      const res = await sandboxPostProcessingAdapterRegistry[script.id].run({ runId: workspaceId, productType, scriptId: script.id, inputDir: stage, outputDir: outDir, batchId: retryBatch.id })
      if (!res.ok) return endFailed(res.failure ?? makeAutomationError('POSTPROCESSING_NONZERO_EXIT', { productType, sku, stageDetail: script.id, technicalMessage: res.error }), `pp:${script.id}`)
      const name = script.id === 'autoMCFF' ? 'dimensions.csv' : 'measurements.xlsx'
      refreshed.push({ name, from: join(outDir, name) })
      if (res.artifact?.kind === 'measurementData') {
        const pathKey = script.id === 'autoMCFF' ? 'csvPath' : 'xlsxPath'
        artifacts = artifacts.filter(a => !(a.kind === 'measurementData' && pathKey in a.data))
        artifacts.push({ kind: 'measurementData', data: { ...res.artifact.data, [pathKey]: join(finalDir, name) } })
      }
    }
  }

  for (const f of await readdir(post.outputDir)) {
    if (!f.startsWith('.') && !METADATA_FILE_NAMES.has(f)) await copyFile(join(post.outputDir, f), join(finalDir, f))
  }
  for (const r of refreshed) await copyFile(r.from, join(finalDir, r.name))

  // Earlier-stage artifacts, so a later retry (or post-processing retry) sees them.
  if (boundary === 'preprocessing') {
    await copySkuFiles(sandboxPreprocessedDir(workspaceId, productType), sandboxPreprocessedDir(runId, productType), sku)
    await copySkuFiles(sandboxEditingInputDir(workspaceId, productType), sandboxEditingInputDir(runId, productType), sku)
  }
  if (boundary !== 'post_processing') await copySkuFiles(editingOutputDir, sandboxEditingOutputDir(runId, productType), sku)

  await mergeStageRecord({ origBatchId: origPipeline.batchId, retryBatchId: retryBatch.id, productType, sku, origEditingOutputDir: sandboxEditingOutputDir(runId, productType) })

  recorder.completeSku(productType, sku)
  await recorder.flush()
  await queueRunUpdate(runId, detail => {
    const pipelines = detail.pipelines.map(pl =>
      pl.productType === productType
        ? {
            ...pl,
            status: 'completed' as const,
            error: null,
            failure: null,
            activity: null,
            postProcessingOutputDir: finalDir,
            postProcessingArtifacts: artifacts,
            batchId: pl.batchId ?? retryBatch.id,
          }
        : pl,
    )
    const patched = { ...detail, pipelines }
    return {
      pipelines,
      ...(TERMINAL_RUN_STATUSES.has(detail.status) ? { status: computeFinalStatus(patched), failure: null } : {}),
    }
  })
}

// Upserts the retried image's Legacy stage record into the product's ORIGINAL
// Batch (so Final Review sees it), rebasing its paths onto the original
// editing-output directory the artifacts were merged into. Other images'
// records are untouched. With no original Batch, the retry's own Batch is
// adopted as the product's Batch by the caller.
async function mergeStageRecord(p: {
  origBatchId: string | null
  retryBatchId: string
  productType: SandboxProductType
  sku: string
  origEditingOutputDir: string
}): Promise<void> {
  if (!p.origBatchId) return
  const stageType: StageType = p.productType === 'watch' ? 'watch' : 'editing'
  const retryBatch = await getBatch(p.retryBatchId)
  const orig = await getBatch(p.origBatchId)
  const retryStage = retryBatch?.stages.find(s => s.type === stageType)
  const origStage = orig?.stages.find(s => s.type === stageType)
  if (!retryStage || !origStage) return

  const stripExt = (n: string) => (extname(n) ? n.slice(0, -extname(n).length) : n)
  const rebase = (path: string | null | undefined) => (path ? join(p.origEditingOutputDir, basename(path)) : path ?? null)
  const fresh = retryStage.images.filter(i => stripExt(i.name) === p.sku).map<StageImageRecord>(rec => ({
    ...rec,
    outputPath: rebase(rec.outputPath),
    ...(rec.assets
      ? { assets: Object.fromEntries(Object.entries(rec.assets).map(([k, v]) => [k, typeof v === 'string' ? rebase(v) : v])) as StageImageRecord['assets'] }
      : {}),
  }))
  if (fresh.length === 0) return
  const images = [...origStage.images.filter(i => stripExt(i.name) !== p.sku), ...fresh]
  await updateStage(p.origBatchId, stageType, { images, counts: countsFromImages(images, Math.max(origStage.counts.total, images.length)) })
}
