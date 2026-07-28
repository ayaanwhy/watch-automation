import { ipcMain, app } from 'electron'
import { join, extname } from 'node:path'
import { stat, readdir } from 'node:fs/promises'
import { createSubprocessRunner } from '../services/subprocessRunner'
import { logger } from '../logger'
import type {
  RingBraceletStartPayload,
  RingBraceletStartResult,
  RingBraceletValidatePayload,
  BatchValidationResult,
} from '../../src/types/ipc'
import type { StageImageRecord } from '../../src/types/batch'

// Same supported extensions runner.py checks (SUPPORTED_EXTENSIONS).
const SUPPORTED_EXTENSIONS = new Set(['.png', '.webp'])

// preprocessing/RingBracelet is a sibling of preprocessing/UBG — same depth
// below the monorepo root as electron_runner.py, see preprocessHandlers.ts's
// getRunnerPath.
function getRunnerPath(): string {
  return join(app.getAppPath(), '..', '..', 'preprocessing', 'RingBracelet', 'runner.py')
}

function buildArgs(runnerPath: string, payload: RingBraceletStartPayload): string[] {
  const args: string[] = [
    runnerPath,
    '--input-dir', payload.inputDir,
    '--output-dir', payload.outputDir,
    '--product', payload.product,
  ]
  if (payload.splitY !== undefined) args.push('--split-y', String(payload.splitY))
  // Phase 11.5C — omitted means 'automatic', matching pre-11.5C behavior
  // (masking always ran) exactly.
  args.push('--processing-mode', payload.processingMode ?? 'automatic')
  return args
}

const runner = createSubprocessRunner<RingBraceletStartPayload>({
  label: 'ring-bracelet',
  stageType: 'editing',
  eventChannel: 'ring-bracelet:event',
  doneChannel: 'ring-bracelet:done',
  alreadyRunningError: 'A Ring & Bracelet job is already running',
  // Reuses the same interpreter resolution as Preprocessing — this runner's
  // dependencies (cv2, numpy, Pillow) are a subset of what's already checked
  // for there, so a second resolver would be pure duplication for no
  // behavioral difference.
  noPythonError: 'No suitable Python interpreter found.',
  runnerLabel: 'Ring & Bracelet runner',
  getRunnerPath,
  buildArgs,
  buildStageConfig: (payload) => ({
    product: payload.product,
    splitY: payload.splitY ?? 0.5,
    processingMode: payload.processingMode ?? 'automatic',
  }),
  mapCompleteEvent: (event): Omit<StageImageRecord, 'name'> => {
    const frontFullImage = (event['frontFullImage'] as string) ?? null
    const frontImage = (event['frontImage'] as string) ?? null
    return {
      status: 'completed',
      // outputPath stays the single canonical path every stage sets —
      // frontFullImage is the representative "the whole asset" output;
      // frontImage (and any future named output) lives in assets only.
      outputPath: frontFullImage,
      assets: {
        ...(frontFullImage ? { frontFullImage } : {}),
        ...(frontImage ? { frontImage } : {}),
        detected: Boolean(event['detected']),
      },
      error: null,
      durationMs: (event['duration_ms'] as number) ?? null,
    }
  },
})

export function registerRingBraceletHandlers(): void {
  ipcMain.handle('ring-bracelet:start', async (_event, payload: RingBraceletStartPayload): Promise<RingBraceletStartResult> => {
    return runner.start(payload)
  })

  // Cooperative only, same rationale as preprocess:cancel even though
  // there's no GPU work to protect here — consistency of the cancellation
  // contract across every subprocess-backed stage.
  ipcMain.handle('ring-bracelet:cancel', async (_event, payload: { jobId: string }): Promise<{ ok: boolean }> => {
    return runner.cancel(payload.jobId)
  })

  // Phase 11.5D — a lightweight counterpart to Watch's batch:validate: does
  // the input folder exist and does it contain at least one image runner.py
  // would actually pick up? No spreadsheet/SKU-matching (Ring & Bracelet has
  // none) and no output-folder existence check (runner.py creates
  // --output-dir itself via mkdir(parents=True, exist_ok=True), unlike
  // Watch's output folder, which must already exist).
  ipcMain.handle('ring-bracelet:validate-input', async (
    _event,
    payload: RingBraceletValidatePayload,
  ): Promise<BatchValidationResult> => {
    const errors: string[] = []
    let imageCount: number | undefined

    try {
      const s = await stat(payload.inputDir)
      if (!s.isDirectory()) {
        errors.push('Input folder path is not a directory.')
      } else {
        const files = await readdir(payload.inputDir)
        imageCount = files.filter(f => !f.startsWith('._') && SUPPORTED_EXTENSIONS.has(extname(f).toLowerCase())).length
        if (imageCount === 0) {
          errors.push('No PNG or WEBP images found in the input folder.')
        }
      }
    } catch {
      errors.push('Input folder does not exist.')
    }

    if (errors.length === 0) {
      logger.info(`ring-bracelet:validate-input — ok, ${imageCount ?? 0} images`)
    } else {
      logger.warn(`ring-bracelet:validate-input — ${errors.join('; ')}`)
    }

    return { ok: errors.length === 0, errors, imageCount }
  })
}
