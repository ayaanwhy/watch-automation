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
import { engineProjectRoot } from './engine/runtime'
import { join } from 'node:path'
import type { SandboxTemporaryBatchDetail, SandboxTemporaryBatchSummary } from '../../src/sandbox/types/sandboxTemporaryBatch'
import type { SandboxEditor } from '../../src/sandbox/types/sandboxDisposition'
import type { SandboxQaHandoffPayload, SandboxManualEditorHandoffPayload } from '../../src/sandbox/types/sandboxReview'

// The one real image this repo has for exercising a genuine end-to-end
// Watch pipeline run (Phase 14's own canonical fixture — used throughout
// boundaryDetectionMapping.test.ts etc). app.getAppPath() resolution
// mirrors preprocessHandlers.ts's getRunnerPath() exactly (same
// monorepo-relative convention every main-process file already uses).
// Ring/Bracelet/Earring/Necklace/Gemstone have no equivalent real sample
// image committed to this repo, so their mock entries keep imagePath: ''
// (see below) — an honest gap, not filled with a fabricated path.
function sampleWatchImagePath(): string {
  return join(engineProjectRoot(), 'sampledata', '1688KM11.png')
}

export interface SandboxApiClient {
  listTemporaryBatches(): Promise<SandboxTemporaryBatchSummary[]>
  getTemporaryBatchDetail(id: string): Promise<SandboxTemporaryBatchDetail | null>
  listEditors(): Promise<SandboxEditor[]>
  // Phase 15.6 — extended from Phase 15.0's placeholder single-string-arg
  // signature (never called by anything until this phase) to the real
  // per-item payload Final Review actually has once an item is approved/
  // rejected. Renamed to make the direction explicit, matching section
  // 11's suggested naming.
  handoffApprovedToQa(payload: SandboxQaHandoffPayload): Promise<{ ok: boolean; error?: string }>
  handoffRejectedToManualEditor(payload: SandboxManualEditorHandoffPayload): Promise<{ ok: boolean; error?: string }>
}

// Fixed, in-memory fixture data — deliberately small and clearly fake
// (ids/names are labeled "mock-") so it can never be mistaken for a real
// batch if it somehow surfaced in a screenshot or log.
//
// Extended for Phase 15.2 (Sandbox Dashboard/Universal Configuration) with
// two more batches, covering the combinations the UI actually needs to
// exercise: a batch spanning every currently-real pipeline (watch/ring/
// bracelet/earring), and a batch containing only the two not-yet-available
// product types (necklace/gemstone) so the "unavailable pipeline" state has
// real mock data to render against, not a hardcoded UI-only fake.
// Phase 15.3 — Watch entries carry widthMm/measureBy (the two fields real
// Watch execution needs that Sandbox has no measurement source for
// otherwise — see sandboxTemporaryBatch.ts's own comment) so the
// orchestrator's real Watch pipeline can be genuinely exercised end-to-end
// against this mock data, not just structurally plumbed. Earring entries
// carry earringType similarly. Values are plausible but explicitly mock —
// sourced from nowhere but this fixture.
//
// Extended for Phase 15.5 (Measurement & Product Data Normalization) with
// deliberate variety so the normalizer/validator has real cases to run
// against, not just the happy path: a Dial-measured Watch (exercises the
// Case/Dial distinction — see sandboxProductData.ts), a Watch with no
// measurement data at all (missing), a Watch with a negative widthMm
// (present-but-invalid, distinct from missing), and Ring/Bracelet entries
// carrying generic width/height product data (currently unconsumed by any
// real pipeline — see normalizeSandboxProductData.ts's own header — but
// real product-catalog-shaped data for the normalizer to exercise). Every
// value here is mock-only, labeled as such by the MOCK- sku prefix.
function buildMockTemporaryBatches(): SandboxTemporaryBatchDetail[] {
  const watchImagePath = sampleWatchImagePath()
  return [
    {
      id: 'mock-temp-batch-1',
      name: 'Mock Temporary Batch 1',
      productTypes: ['watch', 'ring'],
      imageCount: 5,
      images: [
        // Valid — Case measurement.
        { sku: 'MOCK-WATCH-001', imagePath: watchImagePath, productType: 'watch', widthMm: 42, measureBy: 'Case' },
        // Valid — Dial measurement (distinct from Case; see
        // sandboxProductData.ts's SandboxWatchMeasurement).
        { sku: 'MOCK-WATCH-002', imagePath: watchImagePath, productType: 'watch', widthMm: 30.5, measureBy: 'Dial' },
        // Missing measurement entirely — no widthMm, no measureBy.
        { sku: 'MOCK-WATCH-003', imagePath: watchImagePath, productType: 'watch' },
        // Present but invalid — a negative widthMm is not silently
        // coerced or dropped; it's distinguishable from "missing" at
        // validation time.
        { sku: 'MOCK-WATCH-004', imagePath: watchImagePath, productType: 'watch', widthMm: -5, measureBy: 'Case' },
        { sku: 'MOCK-RING-001', imagePath: '', productType: 'ring' },
      ],
    },
    {
      id: 'mock-temp-batch-2',
      name: 'Mock Temporary Batch 2 — Mixed Editing',
      productTypes: ['ring', 'bracelet', 'earring'],
      imageCount: 4,
      images: [
        // Generic product dimensions — not consumed by Ring/Bracelet's
        // real pipeline today, but real catalog-shaped data for the
        // normalizer/validator to exercise (see this file's own note).
        { sku: 'MOCK-RING-002', imagePath: '', productType: 'ring', widthMm: 18.2, heightMm: 18.2 },
        { sku: 'MOCK-BRACELET-001', imagePath: '', productType: 'bracelet', widthMm: 60, heightMm: 8 },
        { sku: 'MOCK-EARRING-001', imagePath: '', productType: 'earring', earringType: 'stud' },
        // Earring with no classification — exercises the "missing
        // required Earring metadata" validation path.
        { sku: 'MOCK-EARRING-002', imagePath: '', productType: 'earring' },
      ],
    },
    {
      id: 'mock-temp-batch-3',
      name: 'Mock Temporary Batch 3 — Necklace & Gemstone',
      productTypes: ['necklace', 'gemstone'],
      imageCount: 2,
      images: [
        { sku: 'MOCK-NECKLACE-001', imagePath: '', productType: 'necklace' },
        // Gemstone needs width, height AND Shape (resizeGems) — none of it is
        // ever defaulted. (imagePath stays empty like every non-Watch mock
        // item: no real sample image exists in this repo.)
        { sku: 'MOCK-GEMSTONE-001', imagePath: '', productType: 'gemstone', widthMm: 6, heightMm: 4, shape: 'Round' },
      ],
    },
  ]
}

const MOCK_TEMPORARY_BATCHES: SandboxTemporaryBatchDetail[] = buildMockTemporaryBatches()

const MOCK_EDITORS: SandboxEditor[] = [
  { id: 'mock-editor-1', name: 'Mock Editor One' },
  { id: 'mock-editor-2', name: 'Mock Editor Two' },
]

// One log entry per handoff attempt this mock has seen — the only way
// "the mock should record enough information to prove that the handoff
// happened" (Phase 15.6 section 6) can be checked from a test, since
// there's no real network call to intercept. Mock-only: not part of the
// SandboxApiClient interface, so nothing outside this file/its tests
// depends on it.
export type SandboxMockHandoffLogEntry =
  | { kind: 'qa'; payload: SandboxQaHandoffPayload; at: string }
  | { kind: 'manual-editor'; payload: SandboxManualEditorHandoffPayload; at: string }

export class MockSandboxApiClient implements SandboxApiClient {
  private handoffLog: SandboxMockHandoffLogEntry[] = []

  async listTemporaryBatches(): Promise<SandboxTemporaryBatchSummary[]> {
    return MOCK_TEMPORARY_BATCHES.map(({ images: _images, ...summary }) => summary)
  }

  async getTemporaryBatchDetail(id: string): Promise<SandboxTemporaryBatchDetail | null> {
    return MOCK_TEMPORARY_BATCHES.find(b => b.id === id) ?? null
  }

  async listEditors(): Promise<SandboxEditor[]> {
    return MOCK_EDITORS
  }

  async handoffApprovedToQa(payload: SandboxQaHandoffPayload): Promise<{ ok: boolean; error?: string }> {
    this.handoffLog.push({ kind: 'qa', payload, at: new Date().toISOString() })
    return { ok: true }
  }

  async handoffRejectedToManualEditor(payload: SandboxManualEditorHandoffPayload): Promise<{ ok: boolean; error?: string }> {
    this.handoffLog.push({ kind: 'manual-editor', payload, at: new Date().toISOString() })
    return { ok: true }
  }

  // Mock-only inspection surface for tests — not part of SandboxApiClient.
  getHandoffLog(): SandboxMockHandoffLogEntry[] {
    return this.handoffLog
  }
}

// Module-level singleton, mirroring boundaryDetection.ts's detectionQueue
// convention — every Sandbox caller shares the same client instance rather
// than constructing its own. Swapping to a real client later is a one-line
// change here, not a call-site migration.
export const sandboxApiClient: SandboxApiClient = new MockSandboxApiClient()
