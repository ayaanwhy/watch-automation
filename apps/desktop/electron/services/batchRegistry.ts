// Batch registry — persistence for the Batch-first workflow model (Phase 9B).
//
// Storage (one-concern-per-file convention, extended to a directory):
//   userData/batches/index.json      — { version, nextSeq, batches: BatchSummaryRecord[] }
//   userData/batches/<batchId>.json  — BatchDetailRecord (per-stage detail)
//
// The index stays small (no per-stage detail) so the Home history list loads
// instantly. All state derivation is delegated to the pure batchModel module;
// this file only reads/writes and keeps index summaries in sync with details.

import { app } from 'electron'
import { readFile, readdir, mkdir, unlink, rename } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger'
import { atomicWriteJson } from './atomicFile'
import { BATCH_REGISTRY_VERSION } from '../../src/types/batch'
import type {
  BatchDetailRecord,
  BatchMode,
  BatchSummaryRecord,
  StagePatch,
  StageType,
} from '../../src/types/batch'
import { applyStagePatch, createBatchDetail, recompute, summarize } from './batchModel'

interface BatchIndex {
  version: number
  nextSeq: number
  // Independent counter for Testing-mode batches (Phase 10F) — kept separate
  // from nextSeq so Testing and Production numbering don't interleave.
  nextTestSeq: number
  batches: BatchSummaryRecord[]
}

function batchesDir(): string {
  return join(app.getPath('userData'), 'batches')
}
function indexPath(): string {
  return join(batchesDir(), 'index.json')
}
function detailPath(id: string): string {
  return join(batchesDir(), `${id}.json`)
}

// Phase 11E: a detail file that fails to parse is genuinely corrupt, not a
// read racing a write — every write in this module goes through
// atomicWriteJson (temp-then-rename), so a reader never observes a
// partially-written file. Moving it aside makes the corruption visible
// (surfaced in logs, and the batch simply stops appearing rather than
// endlessly failing the same read) while preserving the raw bytes for
// manual recovery, instead of leaving a file that fails forever in place.
async function quarantineCorruptFile(path: string): Promise<void> {
  try {
    const quarantineDir = join(batchesDir(), 'quarantine')
    await mkdir(quarantineDir, { recursive: true })
    await rename(path, join(quarantineDir, `${basename(path)}.${Date.now()}.corrupt`))
    logger.error(`batch-registry — quarantined unreadable file: ${path}`)
  } catch (err) {
    logger.error(`batch-registry — failed to quarantine ${path}`, err)
  }
}

// index.json is a rebuildable cache derived from the batch detail files
// (Phase 11E) — the detail files are the sole source of truth. Used both as
// readIndex's fallback (a missing/corrupt index no longer silently discards
// the user's batch history — every detail file survives independently on
// disk) and by reconcileBatchesOnStartup for a guaranteed-fresh index on
// every launch.
async function rebuildIndexFromDetails(): Promise<BatchIndex> {
  let files: string[]
  try {
    files = await readdir(batchesDir())
  } catch {
    return { version: BATCH_REGISTRY_VERSION, nextSeq: 1, nextTestSeq: 1, batches: [] }
  }
  const detailFiles = files.filter(f => f.endsWith('.json') && f !== 'index.json')

  const batches: BatchSummaryRecord[] = []
  let maxSeq = 0
  let maxTestSeq = 0

  for (const file of detailFiles) {
    const path = join(batchesDir(), file)
    try {
      const detail = JSON.parse(await readFile(path, 'utf-8')) as BatchDetailRecord
      batches.push(summarize(detail))
      if (detail.mode === 'testing') maxTestSeq = Math.max(maxTestSeq, detail.seq)
      else maxSeq = Math.max(maxSeq, detail.seq)
    } catch (err) {
      logger.error(`batch-registry — corrupt batch detail file: ${file}`, err)
      await quarantineCorruptFile(path)
    }
  }

  return { version: BATCH_REGISTRY_VERSION, nextSeq: maxSeq + 1, nextTestSeq: maxTestSeq + 1, batches }
}

async function readIndex(): Promise<BatchIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(), 'utf-8')) as BatchIndex
    if (!parsed || !Array.isArray(parsed.batches) || typeof parsed.nextSeq !== 'number') {
      throw new Error('malformed batch index')
    }
    // Index files written before Phase 10F won't have this counter — default
    // it in rather than requiring a migration; existing batches/nextSeq are
    // untouched either way.
    if (typeof parsed.nextTestSeq !== 'number') parsed.nextTestSeq = 1
    return parsed
  } catch (err) {
    // ENOENT means no registry has been created yet — normal on first run.
    // Anything else (parse failure, malformed shape) means an existing
    // index could not be read — rebuild it from the detail files rather
    // than starting from an empty registry (Phase 11E; previously this
    // silently discarded the user's entire batch history even though every
    // individual batch's data was still safely on disk).
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.error('batch-registry — failed to read index.json, rebuilding from batch detail files', err)
    }
    return rebuildIndexFromDetails()
  }
}

async function writeIndex(index: BatchIndex): Promise<void> {
  await mkdir(batchesDir(), { recursive: true })
  await atomicWriteJson(indexPath(), index)
}

// Startup reconciliation (Phase 11E): a stage still 'running' when the app
// launches can only mean the process was killed mid-run (crash, force-quit)
// — no subprocess can possibly still be executing for it at cold start.
// Marking it 'failed' makes that visible and re-runnable instead of stuck
// showing "running" forever. This is deliberately not a resume system: the
// batch is left exactly as interrupted, and idempotent reruns (Universal
// Preprocessing / Ring & Bracelet skip images whose output already exists)
// are what make retrying it cheap, not a dedicated resume flow.
export async function reconcileBatchesOnStartup(): Promise<void> {
  let files: string[]
  try {
    files = await readdir(batchesDir())
  } catch {
    return // No batches directory yet — nothing to reconcile.
  }
  const detailFiles = files.filter(f => f.endsWith('.json') && f !== 'index.json')

  const batches: BatchSummaryRecord[] = []
  let maxSeq = 0
  let maxTestSeq = 0
  let interruptedCount = 0
  let quarantinedCount = 0

  for (const file of detailFiles) {
    const path = join(batchesDir(), file)
    let detail: BatchDetailRecord
    try {
      detail = JSON.parse(await readFile(path, 'utf-8')) as BatchDetailRecord
    } catch (err) {
      logger.error(`batch-registry — corrupt batch detail file: ${file}`, err)
      await quarantineCorruptFile(path)
      quarantinedCount++
      continue
    }

    const now = new Date().toISOString()
    let batchWasInterrupted = false
    for (const stage of detail.stages) {
      if (stage.status !== 'running') continue
      detail = applyStagePatch(detail, stage.type, {
        status: 'failed',
        error: 'Interrupted — the application was closed while this stage was running.',
      }, now)
      batchWasInterrupted = true
    }
    if (batchWasInterrupted) {
      await atomicWriteJson(path, detail)
      interruptedCount++
    }

    batches.push(summarize(detail))
    if (detail.mode === 'testing') maxTestSeq = Math.max(maxTestSeq, detail.seq)
    else maxSeq = Math.max(maxSeq, detail.seq)
  }

  await writeIndex({ version: BATCH_REGISTRY_VERSION, nextSeq: maxSeq + 1, nextTestSeq: maxTestSeq + 1, batches })

  logger.info(
    `batch-registry — startup reconciliation: ${detailFiles.length} batch(es) scanned, ` +
    `${interruptedCount} interrupted stage(s) marked failed, ${quarantinedCount} corrupt file(s) quarantined`
  )
}

function upsertSummary(index: BatchIndex, detail: BatchDetailRecord): void {
  const summary = summarize(detail)
  const i = index.batches.findIndex(b => b.id === summary.id)
  if (i >= 0) index.batches[i] = summary
  else index.batches.push(summary)
}

export async function createBatch(params: {
  sourceDir: string
  pipeline: StageType[]
  title?: string
  mode?: BatchMode
}): Promise<BatchDetailRecord> {
  await mkdir(batchesDir(), { recursive: true })
  const index = await readIndex()
  const mode: BatchMode = params.mode ?? 'production'
  const seq = mode === 'testing' ? index.nextTestSeq : index.nextSeq
  const id = `batch-${Date.now()}-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()

  const detail = createBatchDetail({
    id,
    seq,
    sourceDir: params.sourceDir,
    pipeline: params.pipeline,
    title: params.title,
    mode,
    now,
  })

  await atomicWriteJson(detailPath(id), detail)
  if (mode === 'testing') index.nextTestSeq = seq + 1
  else index.nextSeq = seq + 1
  upsertSummary(index, detail)
  await writeIndex(index)

  logger.info(`batch-registry — created ${id} (${detail.title}, mode=${mode}, pipeline=[${params.pipeline.join(', ')}])`)
  return detail
}

export async function listBatches(): Promise<BatchSummaryRecord[]> {
  const index = await readIndex()
  return [...index.batches].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export async function getBatch(id: string): Promise<BatchDetailRecord | null> {
  try {
    return JSON.parse(await readFile(detailPath(id), 'utf-8')) as BatchDetailRecord
  } catch (err) {
    // ENOENT is an expected case for a not-yet-created or already-deleted
    // batch. Anything else means an existing detail file could not be
    // parsed — genuine corruption, not a read racing a write (every write
    // in this module is atomic; see quarantineCorruptFile) — so it's moved
    // aside rather than left to fail the same way on every future read
    // (Phase 11E; Phase 11A only added the logging here).
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.error(`batch-registry — failed to read batch detail for ${id}`, err)
      await quarantineCorruptFile(detailPath(id))
    }
    return null
  }
}

export async function updateStage(
  id: string,
  stageType: StageType,
  patch: StagePatch,
): Promise<BatchDetailRecord | null> {
  const detail = await getBatch(id)
  if (!detail) return null
  const updated = applyStagePatch(detail, stageType, patch, new Date().toISOString())
  await atomicWriteJson(detailPath(id), updated)
  const index = await readIndex()
  upsertSummary(index, updated)
  await writeIndex(index)
  return updated
}

export async function renameBatch(id: string, title: string): Promise<BatchDetailRecord | null> {
  const detail = await getBatch(id)
  if (!detail) return null
  const updated = recompute({ ...detail, title: title.trim() || detail.title }, new Date().toISOString())
  await atomicWriteJson(detailPath(id), updated)
  const index = await readIndex()
  upsertSummary(index, updated)
  await writeIndex(index)
  return updated
}

// Testing/Production is editable after creation (Phase 10F correction) —
// deliberately just flips the field. seq/title stay exactly as they were
// assigned at creation; retroactively renumbering into the other mode's
// counter sequence was not requested and would risk its own gaps/collisions,
// so it's left alone.
export async function setBatchMode(id: string, mode: BatchMode): Promise<BatchDetailRecord | null> {
  const detail = await getBatch(id)
  if (!detail) return null
  const updated = recompute({ ...detail, mode }, new Date().toISOString())
  await atomicWriteJson(detailPath(id), updated)
  const index = await readIndex()
  upsertSummary(index, updated)
  await writeIndex(index)
  return updated
}

// Finds the batch a Watch stage already belongs to, identified by the exact
// same three fields the stage itself stores (inputDir/outputDir/spreadsheet
// path) — never by re-deriving a session hash or adding a new persisted
// field. Used so "Resume" can reuse an existing batch instead of minting a
// duplicate (Phase 9E.1). Scoped to batches whose pipeline includes 'watch'
// (bounded, not every batch in the registry); most-recently-created match
// wins if more than one somehow qualifies.
export async function findWatchBatch(
  inputFolder: string,
  outputFolder: string,
  spreadsheetPath: string,
): Promise<BatchDetailRecord | null> {
  const index = await readIndex()
  const candidates = index.batches
    .filter(b => b.pipeline.includes('watch'))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  for (const candidate of candidates) {
    const detail = await getBatch(candidate.id)
    const stage = detail?.stages.find(s => s.type === 'watch')
    if (
      stage &&
      stage.inputDir === inputFolder &&
      stage.outputDir === outputFolder &&
      stage.config.spreadsheetPath === spreadsheetPath
    ) {
      return detail!
    }
  }
  return null
}

// Removes only the registry's own bookkeeping (index entry + detail file) —
// never touches generated outputs or any user asset, which the registry
// never wrote to in the first place.
export async function deleteBatch(id: string): Promise<boolean> {
  const index = await readIndex()
  const existed = index.batches.some(b => b.id === id)
  index.batches = index.batches.filter(b => b.id !== id)
  await writeIndex(index)
  try {
    await unlink(detailPath(id))
  } catch {
    // Detail file already gone — fine, the index entry is what mattered.
  }
  logger.info(`batch-registry — deleted ${id}`)
  return existed
}
