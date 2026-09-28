// Real makeCompareRB adapter (Phase 15.7) — Ring & Bracelet compulsory step
// 3. See postProcessing/makeCompareRB/runner.py. The original script (post-
// scripts/makeCompareRB.py) blocked on a Tkinter preview window before
// writing anything; the headless version always proceeds (Sandbox's own
// Final Review is the real human checkpoint downstream — see that script's
// own doc comment). Works on a copy of compressorNew's output: the script
// only ADDS ;compare files, never overwrites frontImage/frontFullImage, so
// copying first (rather than running in place against the previous stage's
// own directory) is defense-in-depth, not something the script strictly
// requires.
import { copyDirFlat, dirHasFiles, guarded, outputMissing, postProcessingScriptPath, runPostProcessingScript, scriptFailure } from './scriptSubprocess'
import type { SandboxPostProcessingAdapter } from './contracts'

export const makeCompareRBAdapter: SandboxPostProcessingAdapter = {
  scriptId: 'makeCompareRB',
  concurrency: 'batch-global',
  run: context => guarded('makeCompareRB', async () => {
    const copied = await copyDirFlat(context.inputDir, context.outputDir)
    if (copied === 0) return outputMissing('makeCompareRB', 'No input images were found to process.')
    const result = await runPostProcessingScript(postProcessingScriptPath('makeCompareRB'), ['--dir', context.outputDir])
    if (!result.ok) return scriptFailure('makeCompareRB', result)
    if (!(await dirHasFiles(context.outputDir))) return outputMissing('makeCompareRB', 'The script reported success but produced no output files.')
    return { ok: true, outputDir: context.outputDir, artifact: { kind: 'images', dir: context.outputDir } }
  }),
}
