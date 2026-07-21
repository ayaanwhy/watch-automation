// Pure NDJSON-protocol logic shared by both subprocess-backed processing
// pipelines (Preprocessing, Ring & Bracelet) — Phase 11B.
//
// Deliberately has zero Electron dependency (mirrors batchModel.ts's own
// pure/impure split) so it can be unit-tested directly, unlike
// subprocessRunner.ts which wires this logic to a real ChildProcess,
// BrowserWindow, and the batch registry.
import type { StageImageRecord } from '../../src/types/batch'

// Both runners' module docstrings define this the same way: the process
// exits with this code only when it stopped cooperatively at a safe
// checkpoint after receiving a cancel request — never as a result of an
// external signal.
export const EXIT_CANCELLED = 3

export interface JobBookkeeping {
  succeeded: number
  failed: number
  totalDurationMs: number
  fatalError: string | null
  allImages: string[]
  imageResults: Map<string, Omit<StageImageRecord, 'name'>>
}

/**
 * Applies one parsed NDJSON event to job bookkeeping in place. The event
 * itself is always forwarded to the renderer unchanged by the caller — this
 * only updates the state used at process-close time.
 */
export function applyNdjsonEvent(
  job: JobBookkeeping,
  event: Record<string, unknown>,
  mapCompleteEvent: (event: Record<string, unknown>) => Omit<StageImageRecord, 'name'>,
): void {
  if (event['type'] === 'done') {
    job.succeeded = (event['succeeded'] as number) ?? 0
    job.failed = (event['failed'] as number) ?? 0
    job.totalDurationMs = (event['total_duration_ms'] as number) ?? 0
  }
  if (event['type'] === 'fatal') {
    job.fatalError = (event['error'] as string) ?? 'Unknown fatal error'
  }
  if (event['type'] === 'start') {
    job.allImages = (event['images'] as string[]) ?? []
  }
  if (event['type'] === 'complete') {
    const name = event['image'] as string
    job.imageResults.set(name, mapCompleteEvent(event))
  }
  if (event['type'] === 'error') {
    const name = event['image'] as string
    job.imageResults.set(name, {
      status: 'failed',
      outputPath: null,
      error: (event['error'] as string) ?? 'Unknown error',
      durationMs: null,
    })
  }
}

/**
 * A crash/segfault/OOM-kill exits non-zero without ever emitting a 'fatal'
 * NDJSON event. Prior to Phase 11A this was misclassified as 'completed';
 * any unexpected non-zero (or signal-killed, code === null) exit is now
 * always treated as a failure.
 */
export function classifyExit(
  code: number | null,
  fatalError: string | null,
): { cancelledByUser: boolean; fatalError: string | null } {
  const cancelledByUser = code === EXIT_CANCELLED
  if (!cancelledByUser && code !== 0 && !fatalError) {
    fatalError = `Process exited unexpectedly with code ${code}`
  }
  return { cancelledByUser, fatalError }
}

/**
 * Reconciles every image the runner announced (via its 'start' event)
 * against the terminal results actually observed — an image that never
 * reached a terminal per-image event (cooperative cancellation stops the
 * runner between images; a fatal error ends the batch early) is filled in
 * as cancelled/failed depending on how the batch ended. Mirrors the
 * reconciliation the renderer's own live job context performs for the
 * in-progress grid, so a reopened historical batch shows the same outcome.
 * Counts are derived from this reconciled array, not the runner's own
 * succeeded/failed counters (Phase 10G fix) — those only increment on a
 * terminal per-image NDJSON event, so a cancelled batch's never-completed
 * images were previously excluded from `total` entirely.
 */
export function reconcileImages(
  allImages: string[],
  imageResults: Map<string, Omit<StageImageRecord, 'name'>>,
  cancelledByUser: boolean,
): { images: StageImageRecord[]; counts: { total: number; succeeded: number; failed: number; cancelled: number } } {
  const images: StageImageRecord[] = allImages.map(name => {
    const result = imageResults.get(name)
    if (result) return { name, ...result }
    return {
      name,
      status: cancelledByUser ? 'cancelled' as const : 'failed' as const,
      outputPath: null,
      error: cancelledByUser ? null : 'Not completed',
      durationMs: null,
    }
  })
  const counts = {
    total: images.length,
    succeeded: images.filter(i => i.status === 'completed').length,
    failed: images.filter(i => i.status === 'failed').length,
    cancelled: images.filter(i => i.status === 'cancelled').length,
  }
  return { images, counts }
}
