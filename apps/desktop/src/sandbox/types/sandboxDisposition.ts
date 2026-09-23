// Sandbox-only disposition model for Unified Final Review (Phase 15.0).
// Deliberately separate from Legacy's StageImageRecord.needsFixing (see
// ../../types/batch.ts) — that flag means something different (a human
// isn't satisfied with an otherwise-successful pipeline run) and this phase
// must not repurpose or extend it for Sandbox's approve/reject workflow.
export type SandboxDispositionState = 'pending' | 'approved' | 'rejected'

export interface SandboxEditor {
  id: string
  name: string
}

export interface SandboxDisposition {
  state: SandboxDispositionState
  // Required by callers when state === 'rejected' (enforced at the review
  // UI/handler layer in 15.6, not by this type).
  reason: string | null
  instructions: string | null
  assignedEditor: SandboxEditor | null
  decidedAt: string | null
}
