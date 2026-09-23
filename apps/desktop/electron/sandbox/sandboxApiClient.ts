// SandboxApiClient (Phase 15.0) — the seam to the real, external Sandbox
// API. No real client exists yet: the wire protocol hasn't been supplied,
// so implementing one now would mean inventing it. This interface is kept
// intentionally narrow, matching only what the approved Phase 15
// requirements actually name (Temporary Batch listing/detail, editor
// listing for disposition assignment, and pushing a Final Review outcome
// onward) — no speculative methods.
//
// MockSandboxApiClient is the only implementation for now, used so 15.2's
// Sandbox Dashboard (Temporary Batch selection) and 15.6's Final Review
// have something real to build and test against without a live API.
// RemoteSandboxApiClient (the real HTTP implementation) is out of scope
// for this phase per the explicit exclusion list.
import type { SandboxTemporaryBatchDetail, SandboxTemporaryBatchSummary } from '../../src/sandbox/types/sandboxTemporaryBatch'
import type { SandboxEditor } from '../../src/sandbox/types/sandboxDisposition'

export interface SandboxApiClient {
  listTemporaryBatches(): Promise<SandboxTemporaryBatchSummary[]>
  getTemporaryBatchDetail(id: string): Promise<SandboxTemporaryBatchDetail | null>
  listEditors(): Promise<SandboxEditor[]>
  pushApprovedToQa(sandboxRunId: string): Promise<{ ok: boolean; error?: string }>
  pushRejectedToManualWorkflow(sandboxRunId: string): Promise<{ ok: boolean; error?: string }>
}

// Fixed, in-memory fixture data — deliberately small and clearly fake
// (ids/names are labeled "mock-") so it can never be mistaken for a real
// batch if it somehow surfaced in a screenshot or log.
const MOCK_TEMPORARY_BATCHES: SandboxTemporaryBatchDetail[] = [
  {
    id: 'mock-temp-batch-1',
    name: 'Mock Temporary Batch 1',
    productTypes: ['watch', 'ring'],
    imageCount: 2,
    images: [
      { sku: 'MOCK-WATCH-001', imagePath: '', productType: 'watch' },
      { sku: 'MOCK-RING-001', imagePath: '', productType: 'ring' },
    ],
  },
]

const MOCK_EDITORS: SandboxEditor[] = [
  { id: 'mock-editor-1', name: 'Mock Editor One' },
  { id: 'mock-editor-2', name: 'Mock Editor Two' },
]

export class MockSandboxApiClient implements SandboxApiClient {
  async listTemporaryBatches(): Promise<SandboxTemporaryBatchSummary[]> {
    return MOCK_TEMPORARY_BATCHES.map(({ images: _images, ...summary }) => summary)
  }

  async getTemporaryBatchDetail(id: string): Promise<SandboxTemporaryBatchDetail | null> {
    return MOCK_TEMPORARY_BATCHES.find(b => b.id === id) ?? null
  }

  async listEditors(): Promise<SandboxEditor[]> {
    return MOCK_EDITORS
  }

  async pushApprovedToQa(_sandboxRunId: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: true }
  }

  async pushRejectedToManualWorkflow(_sandboxRunId: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: true }
  }
}

// Module-level singleton, mirroring boundaryDetection.ts's detectionQueue
// convention — every Sandbox caller shares the same client instance rather
// than constructing its own. Swapping to a real client later is a one-line
// change here, not a call-site migration.
export const sandboxApiClient: SandboxApiClient = new MockSandboxApiClient()
