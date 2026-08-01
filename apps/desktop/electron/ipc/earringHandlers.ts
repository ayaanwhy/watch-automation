import { ipcMain, app } from 'electron'
import { join, extname } from 'node:path'
import { stat, readdir, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createSubprocessRunner } from '../services/subprocessRunner'
import { getBatch } from '../services/batchRegistry'
import { parseProductMetadata, discoverImages, matchProductMetadata } from '@wpa/processing/data'
import { classifyMatchedSkus } from '../../src/constants/earringClassification'
import { logger } from '../logger'
import type { EarringType } from '../../src/constants/earringClassification'
import type {
  EarringStartPayload,
  EarringStartResult,
  EarringValidatePayload,
  BatchValidationResult,
} from '../../src/types/ipc'
import type { StageImageRecord } from '../../src/types/batch'

// Same supported extensions runner.py checks.
const SUPPORTED_EXTENSIONS = new Set(['.png', '.webp'])

// preprocessing/Earring is a sibling of preprocessing/UBG and
// preprocessing/RingBracelet — same depth below the monorepo root.
function getRunnerPath(): string {
  return join(app.getAppPath(), '..', '..', 'preprocessing', 'Earring', 'runner.py')
}

// Resolves each matched SKU's earring type from its metadata Sub-Category —
// the one and only place this interpretation happens. Reuses the exact same
// generic parse/match pipeline metadataHandlers.ts (Phase 12B) uses; the
// Earring-specific classification step is layered on top here, in the app
// layer, not in @wpa/processing. The Python runner (preprocessing/Earring/
// runner.py) never re-interprets Category/Sub-Category itself — it only
// ever consumes this already-resolved sidecar (Phase 12C explicit
// requirement, keeping all classification logic in this one place, per
// Phase 12B's original intent).
//
// Unmapped SKUs (matched but Sub-Category didn't resolve to a known type)
// are deliberately omitted from the sidecar rather than given a placeholder
// value — runner.py's existing "SKU missing from sidecar" per-image error
// path handles that case correctly without needing a separate signal.
function resolveEarringTypes(metadataFilePath: string, inputDir: string): Record<string, EarringType> {
  const parsed = parseProductMetadata(metadataFilePath)
  if (parsed.errors.length > 0) {
    throw new Error(`Failed to read product metadata file: ${parsed.errors.join('; ')}`)
  }
  const images = discoverImages(inputDir)
  const match = matchProductMetadata(parsed, images)
  return classifyMatchedSkus(match.matched, match.rows).bySku
}

async function writeMetadataSidecar(sidecar: Record<string, EarringType>): Promise<string> {
  const dir = join(app.getPath('temp'), 'wpa-earring-metadata')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}.json`)
  await writeFile(filePath, JSON.stringify(sidecar), 'utf-8')
  return filePath
}

// Hoop Manual boundary placement (Phase 12E) — reads whatever splits
// HoopBoundaryEditor has persisted onto the editing stage's own
// config.hoopSplits (via batch-registry:set-hoop-split), the single source
// of truth for this data (never the renderer's in-memory state — see
// HoopBoundaryEditor's own loading logic, which reads from the exact same
// place). No batchId, no batch, or no stage yet all resolve to "no splits
// available" rather than an error — every non-Manual-Hoop batch reaches
// here too and simply has nothing to resolve.
async function resolveHoopSplits(batchId: string | undefined): Promise<Record<string, number>> {
  if (!batchId) return {}
  const batch = await getBatch(batchId)
  const stage = batch?.stages.find(s => s.type === 'editing')
  const hoopSplits = stage?.config['hoopSplits']
  return (hoopSplits && typeof hoopSplits === 'object') ? (hoopSplits as Record<string, number>) : {}
}

async function writeSplitsSidecar(splits: Record<string, number>): Promise<string> {
  const dir = join(app.getPath('temp'), 'wpa-earring-splits')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}.json`)
  await writeFile(filePath, JSON.stringify(splits), 'utf-8')
  return filePath
}

// Internal-only fields, never sent by the renderer — computed by the
// earring:start handler below (async: it involves reading the metadata
// sheet, the input folder, and — for splits — the batch registry) before
// calling runner.start(), then read synchronously by buildArgs, whose
// contract — shared across every subprocess-backed pipeline — doesn't allow
// async work at that point.
interface ResolvedEarringStartPayload extends EarringStartPayload {
  metadataSidecarPath: string
  splitsSidecarPath: string
}

function buildArgs(runnerPath: string, payload: ResolvedEarringStartPayload): string[] {
  const args: string[] = [
    runnerPath,
    '--input-dir', payload.inputDir,
    '--output-dir', payload.outputDir,
    '--metadata-file', payload.metadataSidecarPath,
    '--splits-file', payload.splitsSidecarPath,
  ]
  // Omitted means 'automatic', matching every other pipeline's convention.
  args.push('--processing-mode', payload.processingMode ?? 'automatic')
  return args
}

const runner = createSubprocessRunner<ResolvedEarringStartPayload>({
  label: 'earring',
  stageType: 'editing',
  eventChannel: 'earring:event',
  doneChannel: 'earring:done',
  alreadyRunningError: 'An Earring job is already running',
  // Reuses the same interpreter resolution as Preprocessing/Ring & Bracelet
  // — this runner's dependencies (PIL, numpy) are already checked for there.
  noPythonError: 'No suitable Python interpreter found.',
  runnerLabel: 'Earring runner',
  getRunnerPath,
  buildArgs,
  buildStageConfig: (payload) => ({
    product: 'earring',
    metadataPath: payload.metadataFilePath,
    processingMode: payload.processingMode ?? 'automatic',
  }),
  mapCompleteEvent: (event): Omit<StageImageRecord, 'name'> => {
    const compare = (event['compare'] as string) ?? null
    const frontImage = (event['frontImage'] as string) ?? null
    // Hoop only (Phase 12D) — Stud/Drop's events never carry these, so both
    // stay conditionally omitted rather than defaulted, exactly like
    // `detected` already was before this phase (keeps the lowConfidence
    // badge from ever showing for a Stud/Drop image, which has no
    // masking/confidence step to report on).
    const frontFullImage = (event['frontFullImage'] as string) ?? null
    const detected = event['detected']
    return {
      status: 'completed',
      // outputPath stays the single canonical path every stage sets —
      // compare is the representative "the whole asset" output for
      // Earring, mirroring frontFullImage's role for Ring & Bracelet.
      outputPath: compare,
      assets: {
        ...(compare ? { compare } : {}),
        ...(frontImage ? { frontImage } : {}),
        ...(frontFullImage ? { frontFullImage } : {}),
        ...(typeof detected === 'boolean' ? { detected } : {}),
      },
      error: null,
      durationMs: (event['duration_ms'] as number) ?? null,
    }
  },
})

export function registerEarringHandlers(): void {
  ipcMain.handle('earring:start', async (_event, payload: EarringStartPayload): Promise<EarringStartResult> => {
    let sidecar: Record<string, EarringType>
    try {
      sidecar = resolveEarringTypes(payload.metadataFilePath, payload.inputDir)
    } catch (err) {
      logger.error('earring:start — failed to resolve metadata/classification', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    let sidecarPath: string
    try {
      sidecarPath = await writeMetadataSidecar(sidecar)
    } catch (err) {
      logger.error('earring:start — failed to write metadata sidecar', err)
      return { ok: false, error: 'Failed to prepare metadata for the runner.' }
    }

    let splitsSidecarPath: string
    try {
      const splits = await resolveHoopSplits(payload.batchId)
      splitsSidecarPath = await writeSplitsSidecar(splits)
    } catch (err) {
      logger.error('earring:start — failed to prepare hoop splits sidecar', err)
      return { ok: false, error: 'Failed to prepare Hoop split data for the runner.' }
    }

    return runner.start({ ...payload, metadataSidecarPath: sidecarPath, splitsSidecarPath })
  })

  ipcMain.handle('earring:cancel', async (_event, payload: { jobId: string }): Promise<{ ok: boolean }> => {
    return runner.cancel(payload.jobId)
  })

  // Mirrors ring-bracelet:validate-input exactly — folder existence + at
  // least one supported image, nothing metadata-sheet-specific (that
  // surfaces through earring:start's own result, see resolveEarringTypes).
  ipcMain.handle('earring:validate-input', async (
    _event,
    payload: EarringValidatePayload,
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
      logger.info(`earring:validate-input — ok, ${imageCount ?? 0} images`)
    } else {
      logger.warn(`earring:validate-input — ${errors.join('; ')}`)
    }

    return { ok: errors.length === 0, errors, imageCount }
  })
}
