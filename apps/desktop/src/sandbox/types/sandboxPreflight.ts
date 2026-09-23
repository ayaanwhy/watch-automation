// Sandbox readiness/preflight result shapes (Phase 15.0). The checks
// themselves run in the main process (electron/sandbox/sandboxPreflight.ts,
// since they touch the filesystem and network) — this file holds only the
// shared result shape so a future Sandbox dashboard (15.2+) can render a
// report without importing main-process-only code.
export type SandboxPreflightStatus = 'ok' | 'warn' | 'fail' | 'skipped'

export interface SandboxPreflightCheckResult {
  id: string
  label: string
  status: SandboxPreflightStatus
  detail: string
}

export interface SandboxPreflightReport {
  ranAt: string
  checks: SandboxPreflightCheckResult[]
  // Worst status across checks (fail > warn > ok); 'skipped' checks don't
  // affect this unless every check was skipped.
  overall: SandboxPreflightStatus
}
