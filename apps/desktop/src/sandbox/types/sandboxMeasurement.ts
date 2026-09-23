// Candidate Sandbox-only measurement normalization shape (Phase 15.0).
// Explicitly NOT locked — the real post-processing scripts that produce
// measurements have not been inspected yet (they are out of scope for this
// phase; see IMPLEMENTATION_PLAN.md Phase 15 notes). This shape exists so
// downstream 15.0 contracts (SandboxRunDetail, review data) have somewhere
// to point once measurements exist, without guessing the scripts' real
// output format. Sandbox-only — Legacy has no measurement concept and is
// untouched.
export interface SandboxMeasurement {
  widthMm: number | null
  heightMm: number | null
  source: 'detected' | 'manual' | 'unavailable'
}
