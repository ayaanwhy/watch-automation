// Lightweight ETA/throughput estimate for a running job (Phase 13D —
// Dashboard's Now zone and Attention row). Deliberately simple: a linear
// projection from aggregate elapsed-time/completed-count, not the more
// precise "rolling mean of recorded per-image duration_ms" the plan
// reserves for 13F's run-workspace right rail (which needs individual
// per-image timings, not just a job-level completed/total/startedAt
// snapshot). Good enough for a compact card; 13F's richer version is a
// separate, later implementation.

export interface EtaEstimate {
  etaMs: number | null
  throughputPerMin: number | null
}

export function estimateEta(completed: number, total: number, startedAt: number | null, now: number = Date.now()): EtaEstimate {
  if (startedAt === null || completed <= 0 || total <= 0) {
    return { etaMs: null, throughputPerMin: null }
  }
  const elapsedMs = now - startedAt
  if (elapsedMs <= 0) return { etaMs: null, throughputPerMin: null }

  const throughputPerMin = completed / (elapsedMs / 60000)
  const remaining = Math.max(0, total - completed)
  const etaMs = remaining === 0 ? 0 : (elapsedMs / completed) * remaining
  return { etaMs, throughputPerMin }
}

export function formatEta(etaMs: number | null): string {
  if (etaMs === null) return '—'
  if (etaMs < 1000) return 'Almost done'
  const totalSeconds = Math.round(etaMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s left`
  return `${minutes}m ${seconds}s left`
}

export function formatThroughput(throughputPerMin: number | null): string {
  if (throughputPerMin === null) return '—'
  return `${throughputPerMin.toFixed(1)} img/min`
}
