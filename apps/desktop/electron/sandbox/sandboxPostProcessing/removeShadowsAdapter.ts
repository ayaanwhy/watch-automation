// Real removeShadows adapter (Phase 15.7) — Watch compulsory step 1. See
// postProcessing/removeShadows/runner.py's own doc comment for the
// approved scope: shadow-alpha cleanup only (drop pixels below the alpha
// threshold), deliberately WITHOUT the original personal script's
// unconditional 270-degree rotate + trim, which was written for an
// unrelated external dataset and would have silently rotated Sandbox's
// already-correctly-oriented Watch Editing output. Not to be confused with
// Watch's own boundary-detection/shadow-GENERATION pipeline
// (boundaryDetection.ts's SingleFlightQueue, processWatch) — this adapter
// never touches that, runs strictly after Editing, and never issues its
// own detection call.
import { dirHasFiles, guarded, outputMissing, postProcessingScriptPath, runPostProcessingScript, scriptFailure } from './scriptSubprocess'
import type { SandboxPostProcessingAdapter } from './contracts'


const SHADOW_ALPHA_THRESHOLD = 90

export const removeShadowsAdapter: SandboxPostProcessingAdapter = {
  scriptId: 'removeShadows',
  concurrency: 'batch-global',
  run: context => guarded('removeShadows', async () => {
    const result = await runPostProcessingScript(postProcessingScriptPath('removeShadows'), [
      '--input-dir', context.inputDir,
      '--output-dir', context.outputDir,
      '--threshold', String(SHADOW_ALPHA_THRESHOLD),
    ])
    if (!result.ok) return scriptFailure('removeShadows', result)
    if (!(await dirHasFiles(context.outputDir))) return outputMissing('removeShadows', 'The script reported success but produced no output files.')
    return { ok: true, outputDir: context.outputDir, artifact: { kind: 'images', dir: context.outputDir } }
  }),
}
