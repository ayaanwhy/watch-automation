// Real autoMCFF adapter (Phase 15.7) — Ring & Bracelet OPTIONAL step 4.
// See postProcessing/autoMCFF/runner.py's own doc comment for the approved
// product decision this implements: a fixed assumed width per product type
// (60mm Bracelet, 20mm Ring), not Sandbox's real per-SKU widthMm — an
// explicit call made in the Phase 15.7 conversation, not inferred. Produces
// a real dimensions.csv metadata artifact (SKU/Width/Height), represented
// as measurementData, not disguised as an image (Phase 15.7 section 9/16).
// Images still pass through to outputDir unchanged, since this is the last
// script in Ring/Bracelet's canonical order and Final Review needs a real
// image directory regardless of whether this optional step is enabled.
import { join } from 'node:path'
import {
  capabilityUnavailable,
  copyDirFlat,
  fileExists,
  guarded,
  outputMissing,
  postProcessingScriptPath,
  runPostProcessingScript,
  scriptFailure,
} from './scriptSubprocess'
import type { SandboxPostProcessingAdapter } from './contracts'
import type { SandboxProductType } from '../../../src/sandbox/types/sandboxProduct'

const ASSUMED_WIDTH_MM_BY_PRODUCT: Partial<Record<SandboxProductType, number>> = {
  bracelet: 60,
  ring: 20,
}

export const autoMCFFAdapter: SandboxPostProcessingAdapter = {
  scriptId: 'autoMCFF',
  concurrency: 'batch-global',
  run: context =>
    guarded('autoMCFF', async () => {
      const assumedWidthMm = ASSUMED_WIDTH_MM_BY_PRODUCT[context.productType]
      if (assumedWidthMm === undefined) {
        return capabilityUnavailable('autoMCFF', 'POSTPROCESSING_CAPABILITY_UNAVAILABLE', `No assumed width configured for product type '${context.productType}'.`)
      }

      const copied = await copyDirFlat(context.inputDir, context.outputDir)
      if (copied === 0) return outputMissing('autoMCFF', 'No input images were found to process.')

      const outputCsv = join(context.outputDir, 'dimensions.csv')
      const result = await runPostProcessingScript(postProcessingScriptPath('autoMCFF'), [
        '--dir', context.outputDir,
        '--assumed-width-mm', String(assumedWidthMm),
        '--output-csv', outputCsv,
      ])
      if (!result.ok) return scriptFailure('autoMCFF', result)
      if (!(await fileExists(outputCsv))) return outputMissing('autoMCFF', 'The script reported success but dimensions.csv was not created.')

      return {
        ok: true,
        outputDir: context.outputDir,
        artifact: { kind: 'measurementData', data: { csvPath: outputCsv, assumedWidthMm, ...result.resultJson } },
      }
    }),
}
