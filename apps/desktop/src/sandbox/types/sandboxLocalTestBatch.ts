// DEVELOPMENT/TESTING ONLY — a bridge that lets an existing local Legacy
// Automation Batch stand in as a Sandbox "Temporary Batch" so the real
// Sandbox flow can be exercised without the real Sandbox API. Not the
// future production Temporary Batch source; expected to be removed or
// replaced by it. See electron/sandbox/localLegacyBatchSource.ts for the
// (read-only) adapter itself.
import type { SandboxTemporaryBatchSummary } from './sandboxTemporaryBatch'
import type { BatchStatus } from '../../types/batch'

// A local test batch's Sandbox-facing id — the Legacy batch id behind a
// fixed prefix, so it can never collide with a real (or mock) Temporary
// Batch id, and so any main-process code handed a batch id can tell which
// source it must be resolved from without trusting anything else the
// renderer sends along with it.
export const LOCAL_TEST_BATCH_ID_PREFIX = 'local-legacy:'

export function toLocalTestBatchId(legacyBatchId: string): string {
  return `${LOCAL_TEST_BATCH_ID_PREFIX}${legacyBatchId}`
}

export function isLocalTestBatchId(id: string): boolean {
  return id.startsWith(LOCAL_TEST_BATCH_ID_PREFIX)
}

export function legacyBatchIdFromLocalTestBatchId(id: string): string | null {
  return isLocalTestBatchId(id) ? id.slice(LOCAL_TEST_BATCH_ID_PREFIX.length) : null
}

// A SandboxTemporaryBatchSummary (so the existing picker renders it as-is)
// plus only facts the Legacy registry genuinely holds.
export interface SandboxLocalTestBatchSummary extends SandboxTemporaryBatchSummary {
  legacyStatus: BatchStatus
  createdAt: string
  sourceDir: string
}

export interface SandboxLocalTestBatchListResult {
  batches: SandboxLocalTestBatchSummary[]
  // Legacy batches that exist but can't be used as a source, with the exact
  // reason (older batches without a recorded product type, an unmounted
  // drive, ...) — shown rather than silently dropped.
  hidden: { name: string; reason: string }[]
}
