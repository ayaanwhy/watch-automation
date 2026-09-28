// The one honest implementation every Sandbox post-processing script
// currently resolves to (Phase 15.4).
//
// All eight named scripts — imageResizeNew, removeShadows, resizeGems,
// compressorNew, autoMCFF, autoMeasurementCalculator, makeCompareRB (and
// autoMCForIndividual, deliberately excluded from the config model this
// phase — see sandboxPostProcessing.ts's own note) — were searched for
// exhaustively across this repository (Python files, shell scripts,
// package.json scripts, CLI entrypoints, existing subprocess invocations,
// README/documentation, configuration files, sample directories, and every
// existing Legacy integration) and none exist anywhere in it. See
// IMPLEMENTATION_PLAN.md's Phase 15.4 investigation report for the full
// per-script findings.
//
// This adapter never constructs a subprocess, never touches the
// filesystem, and never fabricates a result — it reports exactly why the
// script can't run. When a real script's invocation contract is supplied,
// its entry in registry.ts is replaced with a real adapter; this function
// stays as the honest default for anything still unimplemented.
import type { SandboxPostProcessingAdapter, SandboxPostProcessingAdapterResult } from './contracts'

export function makeUnavailableAdapter(scriptId: string): SandboxPostProcessingAdapter {
  return {
    scriptId,
    concurrency: 'unknown-unavailable',
    async run(): Promise<SandboxPostProcessingAdapterResult> {
      return {
        ok: false,
        unavailable: true,
        error: `Post-processing script '${scriptId}' has no implementation in this repository yet (its invocation contract has not been supplied — see the Phase 15.4 investigation report).`,
      }
    },
  }
}
