// The one place a Temporary Batch id becomes a SandboxTemporaryBatchDetail
// in the main process: a development-only local Legacy batch id
// (LOCAL_TEST_BATCH_ID_PREFIX) resolves through localLegacyBatchSource.ts;
// every other id goes to the SandboxApiClient exactly as before. Used by
// every main-process caller that re-fetches a batch by id (the IPC detail
// handler, run start, Final Review), so a local test batch keeps resolving
// after a reload/re-entry the same way a real one would.
import { sandboxApiClient } from './sandboxApiClient'
import { getLocalTestBatchDetail } from './localLegacyBatchSource'
import { isLocalTestBatchId } from '../../src/sandbox/types/sandboxLocalTestBatch'
import type { SandboxTemporaryBatchDetail } from '../../src/sandbox/types/sandboxTemporaryBatch'

export async function resolveTemporaryBatchDetail(id: string): Promise<SandboxTemporaryBatchDetail | null> {
  return isLocalTestBatchId(id) ? getLocalTestBatchDetail(id) : sandboxApiClient.getTemporaryBatchDetail(id)
}
