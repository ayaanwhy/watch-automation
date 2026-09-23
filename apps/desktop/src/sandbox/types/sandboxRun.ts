// SandboxRun (Phase 15.0) — the Sandbox-level grouping/user-facing
// abstraction over the approved workflow: Temporary Batch -> Universal
// Config -> Preprocessing -> Editing -> Post Processing -> Unified Final
// Review -> Approved/Sandbox QA or Rejected/Manual Editor.
//
// Option B architecture (approved): a SandboxRun groups one or more
// SandboxProductPipeline entries, each of which executes via an ordinary,
// unmodified Legacy Batch record (see ../../types/batch.ts) — Legacy's
// Batch/Stage schema is never touched to understand Sandbox. Sandbox owns
// the grouping relationship entirely on its own side; the Sandbox UI
// exposes SandboxRun/pipeline concepts, never raw Legacy batch ids.
import type { SandboxProductType } from './sandboxProduct'

// Mirrors the approved workflow's stages plus terminal outcomes.
// 'draft' — Temporary Batch selected and Universal Config not yet run.
// 'cancelled'/'failed' are pipeline-level outcomes (mirrors Legacy's
// BatchStatus shape without reusing that type, since Sandbox's status set
// deliberately differs — e.g. 'post_processing' and 'in_review' have no
// Legacy equivalent).
export type SandboxRunStatus =
  | 'draft'
  | 'preprocessing'
  | 'editing'
  | 'post_processing'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'failed'

// One product's execution within a SandboxRun. batchId is the id of the
// ordinary Legacy Batch record actually running this product's pipeline
// (created internally, never surfaced to the Sandbox UI directly) — null
// before that Batch has been created (e.g. still in 'draft').
export interface SandboxProductPipeline {
  productType: SandboxProductType
  batchId: string | null
  status: SandboxRunStatus
  error: string | null
}

export interface SandboxRunSummary {
  id: string
  seq: number
  title: string
  status: SandboxRunStatus
  temporaryBatchId: string
  productTypes: SandboxProductType[]
  createdAt: string
  updatedAt: string
}

export interface SandboxRunDetail extends SandboxRunSummary {
  pipelines: SandboxProductPipeline[]
  // Universal Configuration snapshot for this run. Left as an open record
  // here rather than a named shape — Universal Configuration's actual
  // fields are 15.2 scope (one screen, thin visual arrows, shared
  // operations); locking its shape now would mean guessing it.
  universalConfig: Record<string, unknown>
}
