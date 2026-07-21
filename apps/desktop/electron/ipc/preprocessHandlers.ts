import { ipcMain, app } from 'electron'
import { join } from 'node:path'
import { resolvePreprocessingPython } from '../services/pythonResolver'
import { prepareForEditingHandoff } from '../services/workflowPreparation'
import { createSubprocessRunner, notifyAllWindows } from '../services/subprocessRunner'
import { logger } from '../logger'
import type {
  PreprocessStartPayload,
  PreprocessStartResult,
  PreprocessResolveResult,
  EditingHandoffPayload,
  EditingHandoffResult,
} from '../../src/types/ipc'
import type { StageImageRecord } from '../../src/types/batch'

// app.getAppPath() returns <monorepo>/apps/desktop in both development and
// production source contexts. The runner lives two levels up at
// <monorepo>/preprocessing/UBG/electron_runner.py.
// NOTE: production packaging will require this to be updated when the
// preprocessing assets are bundled alongside the app.
function getRunnerPath(): string {
  return join(app.getAppPath(), '..', '..', 'preprocessing', 'UBG', 'electron_runner.py')
}

function buildArgs(runnerPath: string, payload: PreprocessStartPayload): string[] {
  const args: string[] = [
    runnerPath,
    '--input-dir', payload.inputDir,
    '--output-dir', payload.outputDir,
  ]
  if (payload.scaleFactor !== undefined)      args.push('--scale-factor',      String(payload.scaleFactor))
  if (payload.objectType !== undefined)       args.push('--object-type',       payload.objectType)
  // Phase 10A — operations defaults to both when omitted, matching pre-10A
  // behavior (background removal always ran) for any caller that doesn't
  // set this field.
  const operations = payload.operations ?? ['background_removal', 'upscale']
  if (!operations.includes('background_removal')) args.push('--skip-background-removal')
  if (payload.background !== undefined)       args.push('--background',        payload.background)
  if (payload.backgroundColorHex !== undefined) args.push('--background-color', payload.backgroundColorHex)
  if (payload.outputPpi !== undefined)        args.push('--output-ppi',        String(payload.outputPpi))
  if (payload.outputSuffix !== undefined)     args.push('--output-suffix',     payload.outputSuffix)
  if (payload.refineForeground === true)      args.push('--refine-foreground')
  if (payload.edgeMode !== undefined)         args.push('--edge-mode',         payload.edgeMode)
  if (payload.edgeStrength !== undefined)     args.push('--edge-strength',     String(payload.edgeStrength))
  if (payload.maskBlur !== undefined)         args.push('--mask-blur',         String(payload.maskBlur))
  if (payload.maskOffset !== undefined)       args.push('--mask-offset',       String(payload.maskOffset))
  if (payload.birefnetModelRoot !== undefined) args.push('--birefnet-model-root', payload.birefnetModelRoot)
  if (payload.samCheckpoint !== undefined)    args.push('--sam-checkpoint',    payload.samCheckpoint)
  if (payload.samPointsPerSide !== undefined)       args.push('--sam-points-per-side',       String(payload.samPointsPerSide))
  if (payload.samPointsPerBatch !== undefined)      args.push('--sam-points-per-batch',      String(payload.samPointsPerBatch))
  if (payload.samPredIouThresh !== undefined)       args.push('--sam-pred-iou-thresh',       String(payload.samPredIouThresh))
  if (payload.samStabilityScoreThresh !== undefined) args.push('--sam-stability-score-thresh', String(payload.samStabilityScoreThresh))
  if (payload.samMaxMasks !== undefined)            args.push('--sam-max-masks',             String(payload.samMaxMasks))
  if (payload.samMultimaskOutput !== undefined)     args.push('--sam-multimask-output',      payload.samMultimaskOutput ? '1' : '0')
  return args
}

const runner = createSubprocessRunner<PreprocessStartPayload>({
  label: 'preprocess',
  stageType: 'preprocessing',
  eventChannel: 'preprocess:event',
  doneChannel: 'preprocess:done',
  alreadyRunningError: 'A preprocessing job is already running',
  noPythonError: 'No suitable Python interpreter found. Ensure a Conda environment with torch, sam2, and basicsr is active.',
  runnerLabel: 'Preprocessing runner',
  getRunnerPath,
  buildArgs,
  // Records outputDir and the effective run configuration onto the stage —
  // both fields already existed on StageRecord but were never populated
  // before Phase 9D's Batch Details "configuration used" summary needed them.
  buildStageConfig: (payload) => ({
    scaleFactor: payload.scaleFactor ?? 1,
    objectType: payload.objectType ?? 'generic',
    operations: payload.operations ?? ['background_removal', 'upscale'],
    samPointsPerSide: payload.samPointsPerSide,
    samPointsPerBatch: payload.samPointsPerBatch,
    samPredIouThresh: payload.samPredIouThresh,
    samStabilityScoreThresh: payload.samStabilityScoreThresh,
    samMaxMasks: payload.samMaxMasks,
    samMultimaskOutput: payload.samMultimaskOutput,
  }),
  mapCompleteEvent: (event): Omit<StageImageRecord, 'name'> => ({
    status: 'completed',
    outputPath: (event['output'] as string) ?? null,
    error: null,
    durationMs: (event['duration_ms'] as number) ?? null,
  }),
})

export function registerPreprocessHandlers(): void {
  ipcMain.handle('preprocess:start', async (_event, payload: PreprocessStartPayload): Promise<PreprocessStartResult> => {
    return runner.start(payload)
  })

  ipcMain.handle('preprocess:cancel', async (_event, payload: { jobId: string }): Promise<{ ok: boolean }> => {
    return runner.cancel(payload.jobId)
  })

  // ── preprocess:resolve-python ───────────────────────────────────────────────
  // Diagnostic channel — lets callers confirm which interpreter was resolved
  // without starting a job. Useful for settings UI (Phase 8.5C) and testing.
  ipcMain.handle('preprocess:resolve-python', async (): Promise<PreprocessResolveResult> => {
    const pythonPath = await resolvePreprocessingPython()
    return { pythonPath }
  })

  // ── preprocess:prepare-for-editing-handoff (Phase 10F) ──────────────────────
  // Triggered only by the EditingHandoffDialog action, never during a normal
  // preprocessing run. Fully independent of the subprocess runner — it only
  // reads the completed output folder and writes a new sibling folder; it
  // does not touch the Python process or its state.
  ipcMain.handle('preprocess:prepare-for-editing-handoff', async (
    _event,
    payload: EditingHandoffPayload,
  ): Promise<EditingHandoffResult> => {
    logger.info(`preprocess:prepare-for-editing-handoff — starting for ${payload.sourceDir} (trim=${payload.trim}, rotate=${payload.rotate})`)
    const result = await prepareForEditingHandoff(payload.sourceDir, { trim: payload.trim, rotate: payload.rotate }, (completed, total) => {
      notifyAllWindows('preprocess:prepare-progress', { completed, total })
    })
    if (result.ok) {
      logger.info(
        `preprocess:prepare-for-editing-handoff — done: ${result.imageCount} prepared, ` +
        `${result.skippedCount} skipped, folder=${result.preparedDir}`
      )
    } else {
      logger.warn(`preprocess:prepare-for-editing-handoff — failed: ${result.error}`)
    }
    return result
  })
}
