// Real autoMeasurementCalculator adapter (Phase 15.7) — Earring OPTIONAL
// step 2. See postProcessing/autoMeasurementCalculator/runner.py. Produces
// measurement DATA (an .xlsx file), not another image — represented as a
// measurementData artifact, never disguised as an image (Phase 15.7
// sections 9/16). Images pass through to outputDir unchanged so Final
// Review still has a real image directory whether or not this optional
// step is enabled.
//
// This script additionally needs pandas + openpyxl (to write .xlsx),
// beyond the Pillow-only baseline every other real adapter needs —
// capability is per-script, not one global gate (Phase 15.7 section 4), so
// this adapter does its own extra check and reports honestly if those
// packages aren't available in the resolved interpreter, rather than
// letting a shared global flag claim more than the interpreter actually
// supports.
import { join } from 'node:path'
import { checkPythonModules, resolvePostProcessingPython } from '../../services/pythonResolver'
import {
  capabilityUnavailable,
  fileExists,
  guarded,
  outputMissing,
  postProcessingScriptPath,
  runPostProcessingScript,
  scriptFailure,
} from './scriptSubprocess'
import type { SandboxPostProcessingAdapter } from './contracts'

export const autoMeasurementCalculatorAdapter: SandboxPostProcessingAdapter = {
  scriptId: 'autoMeasurementCalculator',
  concurrency: 'batch-global',
  run: context =>
    guarded('autoMeasurementCalculator', async () => {
      const pythonPath = await resolvePostProcessingPython()
      if (!pythonPath) {
        return capabilityUnavailable('autoMeasurementCalculator', 'POSTPROCESSING_PYTHON_UNAVAILABLE', 'No Python interpreter with Pillow was found.')
      }
      // pandas/openpyxl (spreadsheet output) are checked per-script — the
      // Pillow-only baseline every other script shares isn't enough here.
      if (!(await checkPythonModules(pythonPath, ['pandas', 'openpyxl']))) {
        return capabilityUnavailable('autoMeasurementCalculator', 'POSTPROCESSING_DEPENDENCY_MISSING', `pandas/openpyxl are not importable in ${pythonPath}.`, 'pandas, openpyxl')
      }

      // The script itself copies source images into --output-dir alongside
      // writing measurements.xlsx (unlike autoMCFF, which measures in place).
      const result = await runPostProcessingScript(postProcessingScriptPath('autoMeasurementCalculator'), [
        '--input-dir', context.inputDir,
        '--output-dir', context.outputDir,
      ])
      if (!result.ok) return scriptFailure('autoMeasurementCalculator', result)

      const outputXlsx = join(context.outputDir, 'measurements.xlsx')
      if (!(await fileExists(outputXlsx))) return outputMissing('autoMeasurementCalculator', 'The script reported success but measurements.xlsx was not created.')

      return {
        ok: true,
        outputDir: context.outputDir,
        artifact: { kind: 'measurementData', data: { xlsxPath: outputXlsx, ...result.resultJson } },
      }
    }),
}
