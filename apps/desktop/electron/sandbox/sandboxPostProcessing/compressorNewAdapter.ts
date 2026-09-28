// Real compressorNew adapter (Phase 15.7) — compulsory for every product
// type. See postProcessing/compressorNew/runner.py. Output format is fixed
// to PNG (the approved non-interactive default — no AVIF output exists
// anywhere else in this repository, and pillow_avif isn't a guaranteed
// dependency; see the Phase 15.7 conversation). Batch/directory-level: one
// subprocess call compresses every PNG in inputDir into outputDir.
import { dirHasFiles, guarded, outputMissing, postProcessingScriptPath, runPostProcessingScript, scriptFailure } from './scriptSubprocess'
import type { SandboxPostProcessingAdapter } from './contracts'

export const compressorNewAdapter: SandboxPostProcessingAdapter = {
  scriptId: 'compressorNew',
  concurrency: 'batch-global',
  run: context => guarded('compressorNew', async () => {
    const result = await runPostProcessingScript(postProcessingScriptPath('compressorNew'), [
      '--input-dir', context.inputDir,
      '--output-dir', context.outputDir,
    ])
    if (!result.ok) return scriptFailure('compressorNew', result)
    if (!(await dirHasFiles(context.outputDir))) return outputMissing('compressorNew', 'The script reported success but produced no output files.')
    return { ok: true, outputDir: context.outputDir, artifact: { kind: 'images', dir: context.outputDir } }
  }),
}
