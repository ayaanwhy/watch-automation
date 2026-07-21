import { ipcMain, app } from 'electron'
import { join } from 'node:path'
import { createSubprocessRunner } from '../services/subprocessRunner'
import type {
  RingBraceletStartPayload,
  RingBraceletStartResult,
} from '../../src/types/ipc'
import type { StageImageRecord } from '../../src/types/batch'

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
}
