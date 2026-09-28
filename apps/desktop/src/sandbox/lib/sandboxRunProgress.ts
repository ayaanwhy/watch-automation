// Sandbox unified progress model (Phase 15.3) — a pure function over a
// SandboxRunDetail, so it's directly testable without any IPC/timing
// involved and reusable by whatever the eventual polished progress UI
// turns out to be (not built yet — this phase only needs the accounting
// itself, per the explicit "create the underlying progress model now, but
// do NOT build the polished progress UI yet").
import type { SandboxRunDetail, SandboxExecutionStatus } from '../types/sandboxRun'

export interface SandboxRunProgress {
  totalPipelines: number
  queued: number
  running: number
  completed: number
  failed: number
  unavailable: number
  cancelled: number
  elapsedMs: number
  // Present only once the run has reached a terminal top-level status
  // (completed/partially_completed/failed/cancelled) — never fabricated
  // while still running, matching "do not fabricate ETA when there is
  // insufficient data."
  totalDurationMs: number | null
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'partially_completed', 'failed', 'cancelled'])

function countByStatus(statuses: SandboxExecutionStatus[], status: SandboxExecutionStatus): number {
  return statuses.filter(s => s === status).length
}

export function summarizeSandboxRunProgress(run: SandboxRunDetail, now: number = Date.now()): SandboxRunProgress {
  const statuses = run.pipelines.map(p => p.status)
  const createdAtMs = Date.parse(run.createdAt)
  const updatedAtMs = Date.parse(run.updatedAt)
  const isTerminal = TERMINAL_RUN_STATUSES.has(run.status)

  return {
    totalPipelines: run.pipelines.length,
    queued: countByStatus(statuses, 'queued'),
    running: countByStatus(statuses, 'running'),
    completed: countByStatus(statuses, 'completed'),
    failed: countByStatus(statuses, 'failed'),
    unavailable: countByStatus(statuses, 'unavailable'),
    cancelled: countByStatus(statuses, 'cancelled'),
    elapsedMs: Math.max(0, (isTerminal ? updatedAtMs : now) - createdAtMs),
    totalDurationMs: isTerminal ? Math.max(0, updatedAtMs - createdAtMs) : null,
  }
}

// ---- image-level progress (automation-engine hardening pass) ---------------
// Pure over the persisted SandboxRunDetail — the same function serves the UI,
// a future API's status endpoint, or a CLI. Everything here is derived from
// real recorded state: per-image stage statuses reported by the runners, and
// timestamps. Nothing is estimated except the ETA, which is only produced
// when there is genuinely enough data (see below) and is otherwise null.
import type { SandboxProductType } from '../types/sandboxProduct'

export interface SandboxProductImageProgress {
  productType: SandboxProductType
  status: SandboxExecutionStatus
  total: number
  completed: number
  failed: number
  cancelled: number
  running: number
  queued: number
  // What the product pipeline is doing right now ("Running compressorNew —
  // batch post-processing"), when it reports one.
  activity: string | null
}

export interface SandboxImageProgress {
  // Images in products that actually run (unavailable products excluded).
  totalImages: number
  completed: number
  failed: number
  cancelled: number
  running: number
  queued: number
  unavailable: number
  // Running images, for "Current: SKU123.png — Background Removal".
  current: { productType: SandboxProductType; sku: string; stage: string | null }[]
  // Images that have finished their per-image work (editing done, or in a
  // terminal state) per minute since the run started.
  ratePerMinute: number | null
  // Remaining per-image work only — batch post-processing time is unknown
  // and never guessed, so ETA is null once only post-processing remains.
  etaMs: number | null
  perProduct: SandboxProductImageProgress[]
}

const MIN_PROCESSED_FOR_RATE = 2
const MIN_ELAPSED_MS_FOR_RATE = 3000

function editingDone(item: SandboxRunDetail['items'][number]): boolean {
  return (item.stages ?? []).some(s => s.phase === 'editing' && s.id === 'editing' && s.status === 'done')
}

export function summarizeImageProgress(run: SandboxRunDetail, now: number = Date.now()): SandboxImageProgress {
  const items = run.items ?? []
  const active = items.filter(i => i.status !== 'unavailable')

  const count = (status: SandboxExecutionStatus) => active.filter(i => i.status === status).length
  const perProduct: SandboxProductImageProgress[] = run.pipelines.map(p => {
    const mine = items.filter(i => i.productType === p.productType && i.status !== 'unavailable')
    const c = (s: SandboxExecutionStatus) => mine.filter(i => i.status === s).length
    return {
      productType: p.productType,
      status: p.status,
      total: mine.length,
      completed: c('completed'),
      failed: c('failed'),
      cancelled: c('cancelled'),
      running: c('running'),
      queued: c('queued'),
      activity: p.activity ?? null,
    }
  })

  const startedMs = run.startedAt ? Date.parse(run.startedAt) : NaN
  const isTerminal = TERMINAL_RUN_STATUSES.has(run.status)
  const processed = active.filter(i => ['completed', 'failed', 'cancelled'].includes(i.status) || editingDone(i)).length
  const remaining = active.length - processed
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, (isTerminal && run.finishedAt ? Date.parse(run.finishedAt) : now) - startedMs) : 0

  let ratePerMinute: number | null = null
  let etaMs: number | null = null
  if (!isTerminal && processed >= MIN_PROCESSED_FOR_RATE && elapsedMs >= MIN_ELAPSED_MS_FOR_RATE) {
    ratePerMinute = processed / (elapsedMs / 60_000)
    if (remaining > 0) etaMs = Math.round((remaining / processed) * elapsedMs)
  }

  return {
    totalImages: active.length,
    completed: count('completed'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    running: count('running'),
    queued: count('queued'),
    unavailable: items.length - active.length,
    current: active.filter(i => i.status === 'running').map(i => ({ productType: i.productType, sku: i.sku, stage: i.stage ?? null })),
    ratePerMinute,
    etaMs,
    perProduct,
  }
}
