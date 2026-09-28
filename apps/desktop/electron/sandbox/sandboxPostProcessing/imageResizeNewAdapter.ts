// Real imageResizeNew adapter (Phase 15.7) — Ring & Bracelet compulsory
// step 1. See postProcessing/imageResizeNew/runner.py for the real script;
// this file only builds the call and verifies the result, never
// constructs image-processing logic of its own (that stays in Python,
// unchanged from post-scripts/imageResizeNew.py's algorithm).
//
// Batch/directory-level (never per-image): the script scans one whole
// directory for ;frontImage/;frontFullImage SKU pairs and pads whichever is
// shorter. Works on a COPY of the Editing output (never the Editing output
// directory itself — this script mutates ;frontFullImage in place, and
// Editing's own output must stay untouched per the Phase 15.7 requirement
// not to overwrite source/editing artifacts unless required and safe).
import { copyDirFlat, dirHasFiles, guarded, outputMissing, postProcessingScriptPath, runPostProcessingScript, scriptFailure } from './scriptSubprocess'
import type { SandboxPostProcessingAdapter } from './contracts'

export const imageResizeNewAdapter: SandboxPostProcessingAdapter = {
  scriptId: 'imageResizeNew',
  concurrency: 'batch-global',
  run: context => guarded('imageResizeNew', async () => {
    const copied = await copyDirFlat(context.inputDir, context.outputDir)
    if (copied === 0) return outputMissing('imageResizeNew', 'No input images were found to process.')
    const result = await runPostProcessingScript(postProcessingScriptPath('imageResizeNew'), ['--dir', context.outputDir])
    if (!result.ok) return scriptFailure('imageResizeNew', result)
    if (!(await dirHasFiles(context.outputDir))) return outputMissing('imageResizeNew', 'The script reported success but produced no output files.')
    return { ok: true, outputDir: context.outputDir, artifact: { kind: 'images', dir: context.outputDir } }
  }),
}
