// Per-image / per-stage progress bookkeeping for one job. Pure state
// transitions over SandboxRunItemState (unit-testable with no I/O) plus a
// small buffered recorder that folds bursts of updates (a subprocess emits
// several events per image) into a single persisted write.
//
// Design rules:
//  - Progress is only ever recorded from REAL signals: a subprocess's own
//    NDJSON progress/complete/error events, or the orchestrator's own step
//    boundaries. Nothing here invents a percentage.
//  - Heartbeats and other high-frequency noise are ignored by callers, never
//    persisted.
//  - The persisted SandboxRun record is the single source of truth; this
//    module only mutates it (via the injected persist function).
import type {
  SandboxItemStage,
  SandboxItemStageStatus,
  SandboxProductPipeline,
  SandboxRunDetail,
  SandboxRunItemState,
} from '../../../src/sandbox/types/sandboxRun'
import type { AutomationError } from '../../../src/sandbox/types/automationError'
import { summarizeAutomationError } from '../../../src/sandbox/types/automationError'
import type { SandboxProductType } from '../../../src/sandbox/types/sandboxProduct'

const TERMINAL: SandboxRunItemState['status'][] = ['completed', 'failed', 'cancelled', 'unavailable']

export function isItemTerminal(item: SandboxRunItemState): boolean {
  return TERMINAL.includes(item.status)
}

// ---- pure transitions (mutate the given item in place) ---------------------

export function setItemStage(item: SandboxRunItemState, stageId: string, status: SandboxItemStageStatus, now: string): void {
  if (isItemTerminal(item)) return
  const stages = item.stages ?? []
  const stage = stages.find(s => s.id === stageId)
  if (!stage) return
  stage.status = status
  if (status === 'running') {
    if (item.status === 'queued') item.status = 'running'
    if (!item.startedAt) item.startedAt = now
    item.stage = stage.label
  } else if (item.stage === stage.label) {
    item.stage = null
  }
}

// Marks the given stages done for an image that finished a stretch of work
// (e.g. all preprocessing sub-steps) — used when a runner reports only a
// final 'complete' rather than per-stage signals.
export function finishStages(item: SandboxRunItemState, stageIds: string[] | 'all-in-phase', phase: SandboxItemStage['phase'], now: string): void {
  if (isItemTerminal(item)) return
  for (const stage of item.stages ?? []) {
    const selected = stageIds === 'all-in-phase' ? stage.phase === phase : stageIds.includes(stage.id)
    if (selected && (stage.status === 'pending' || stage.status === 'running')) stage.status = 'done'
  }
  if (item.stage && !(item.stages ?? []).some(s => s.label === item.stage && s.status === 'running')) item.stage = null
  if (!item.startedAt) item.startedAt = now
  if (item.status === 'queued') item.status = 'running'
}

export function failItem(item: SandboxRunItemState, failure: AutomationError, now: string, stageId?: string): void {
  if (isItemTerminal(item)) return
  const stages = item.stages ?? []
  // A Ring segmentation failure belongs to its own stage, wherever it was reported from.
  const failingId = failure.code.startsWith('RING_SEGMENTATION_') ? 'ring_segmentation' : stageId
  const target = failingId ? stages.find(s => s.id === failingId) : stages.find(s => s.status === 'running')
  if (target) target.status = 'failed'
  item.status = 'failed'
  item.stage = null
  item.failure = failure
  item.error = summarizeAutomationError(failure)
  if (!item.startedAt) item.startedAt = now
  item.finishedAt = now
}

export function completeItem(item: SandboxRunItemState, now: string): void {
  if (isItemTerminal(item)) return
  for (const stage of item.stages ?? []) if (stage.status !== 'failed' && stage.status !== 'skipped') stage.status = 'done'
  item.status = 'completed'
  item.stage = null
  item.error = null
  item.failure = null
  if (!item.startedAt) item.startedAt = now
  item.finishedAt = now
}

// Cancellation only ever affects work that hasn't finished — a completed
// (or already failed) image is never relabelled.
export function cancelItem(item: SandboxRunItemState, now: string): void {
  if (isItemTerminal(item)) return
  for (const stage of item.stages ?? []) if (stage.status === 'pending' || stage.status === 'running') stage.status = 'skipped'
  item.status = 'cancelled'
  item.stage = null
  item.finishedAt = now
}

// ---- buffered recorder -----------------------------------------------------

type Mutator = (state: { items: SandboxRunItemState[]; pipelines: SandboxProductPipeline[] }, now: string) => void
type Persist = (mutate: (detail: SandboxRunDetail) => Partial<SandboxRunDetail>) => Promise<void>

export class JobProgressRecorder {
  private pending: Mutator[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly persist: Persist,
    private readonly flushMs = 150,
  ) {}

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => void this.flush(), this.flushMs)
  }

  private queue(m: Mutator): void {
    this.pending.push(m)
    this.schedule()
  }

  private itemsOf(state: { items: SandboxRunItemState[] }, productType: SandboxProductType, sku?: string) {
    return state.items.filter(i => i.productType === productType && (sku === undefined || i.sku === sku))
  }

  stage(productType: SandboxProductType, sku: string, stageId: string, status: SandboxItemStageStatus): void {
    this.queue((s, now) => this.itemsOf(s, productType, sku).forEach(i => setItemStage(i, stageId, status, now)))
  }

  // Applies to every still-active image of the product — batch-global steps.
  productStage(productType: SandboxProductType, stageId: string, status: SandboxItemStageStatus): void {
    this.queue((s, now) => this.itemsOf(s, productType).forEach(i => setItemStage(i, stageId, status, now)))
  }

  // All stages of a phase done (optionally for a single image).
  phaseDone(productType: SandboxProductType, phase: SandboxItemStage['phase'], sku?: string): void {
    this.queue((s, now) => this.itemsOf(s, productType, sku).forEach(i => finishStages(i, 'all-in-phase', phase, now)))
  }

  // Specific stages done for one image.
  stagesDone(productType: SandboxProductType, sku: string, stageIds: string[], phase: SandboxItemStage['phase']): void {
    this.queue((s, now) => this.itemsOf(s, productType, sku).forEach(i => finishStages(i, stageIds, phase, now)))
  }

  fail(productType: SandboxProductType, sku: string, failure: AutomationError, stageId?: string): void {
    this.queue((s, now) => this.itemsOf(s, productType, sku).forEach(i => failItem(i, failure, now, stageId)))
  }

  failAllActive(productType: SandboxProductType, failure: AutomationError): void {
    this.queue((s, now) => this.itemsOf(s, productType).forEach(i => failItem(i, { ...failure, sku: i.sku }, now)))
  }

  completeAllActive(productType: SandboxProductType): void {
    this.queue((s, now) => this.itemsOf(s, productType).forEach(i => completeItem(i, now)))
  }

  // Single-image variants (Retry Image): concurrent retries of different
  // images of the same product must never touch each other's state.
  completeSku(productType: SandboxProductType, sku: string): void {
    this.queue((s, now) => this.itemsOf(s, productType, sku).forEach(i => completeItem(i, now)))
  }

  cancelSku(productType: SandboxProductType, sku: string): void {
    this.queue((s, now) => this.itemsOf(s, productType, sku).forEach(i => cancelItem(i, now)))
  }

  cancelAllActive(productType: SandboxProductType): void {
    this.queue((s, now) => this.itemsOf(s, productType).forEach(i => cancelItem(i, now)))
  }

  activity(productType: SandboxProductType, activity: string | null): void {
    this.queue(s => {
      const p = s.pipelines.find(x => x.productType === productType)
      if (p) p.activity = activity
    })
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    await this.persist(detail => {
      const now = new Date().toISOString()
      const state = { items: structuredClone(detail.items), pipelines: structuredClone(detail.pipelines) }
      for (const m of batch) m(state, now)
      return { items: state.items, pipelines: state.pipelines }
    })
  }
}

// What a product pipeline (preprocessing/editing) is handed to report real
// progress — implemented by the orchestrator over the recorder + a
// filename->SKU map. Optional everywhere: direct callers (unit tests, a
// future CLI) may pass nothing and the pipelines behave exactly as before.
// Lets a pipeline register "cancel the subprocess job I just started" with the
// engine, so a cancel request reaches in-flight work cooperatively (the
// runners stop themselves at the next safe checkpoint — nothing is killed).
// If cancellation was already requested when a hook is registered, it fires
// immediately, so a cancel can never slip between "check" and "start".
export interface CancelHooks {
  register(cancel: () => void): () => void
}

export interface ProductReporter {
  stage(sku: string, stageId: string, status: SandboxItemStageStatus): void
  stagesDone(sku: string, stageIds: string[], phase: SandboxItemStage['phase']): void
  fail(sku: string, failure: AutomationError, stageId?: string): void
  // Maps a runner-reported file name (e.g. "SKU.png") back to its SKU.
  skuForFile(fileName: string): string | null
}
