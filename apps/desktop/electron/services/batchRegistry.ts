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
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger'
import { BATCH_REGISTRY_VERSION } from '../../src/types/batch'
import type {
  BatchDetailRecord,
  BatchSummaryRecord,
  StagePatch,
  StageType,
} from '../../src/types/batch'
import { applyStagePatch, createBatchDetail, recompute, summarize } from './batchModel'

interface BatchIndex {
  version: number
  nextSeq: number
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

async function atomicWrite(path: string, data: unknown): Promise<void> {
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmp, path)
}

async function readIndex(): Promise<BatchIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(), 'utf-8')) as BatchIndex
    if (!parsed || !Array.isArray(parsed.batches) || typeof parsed.nextSeq !== 'number') {
      throw new Error('malformed batch index')
    }
    return parsed
  } catch {
    return { version: BATCH_REGISTRY_VERSION, nextSeq: 1, batches: [] }
  }
}

async function writeIndex(index: BatchIndex): Promise<void> {
  await mkdir(batchesDir(), { recursive: true })
  await atomicWrite(indexPath(), index)
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
}): Promise<BatchDetailRecord> {
  await mkdir(batchesDir(), { recursive: true })
  const index = await readIndex()
  const seq = index.nextSeq
  const id = `batch-${Date.now()}-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()

  const detail = createBatchDetail({
    id,
    seq,
    sourceDir: params.sourceDir,
    pipeline: params.pipeline,
    title: params.title,
    now,
  })

  await atomicWrite(detailPath(id), detail)
  index.nextSeq = seq + 1
  upsertSummary(index, detail)
  await writeIndex(index)

  logger.info(`batch-registry — created ${id} (${detail.title}, pipeline=[${params.pipeline.join(', ')}])`)
  return detail
}

export async function listBatches(): Promise<BatchSummaryRecord[]> {
  const index = await readIndex()
  return [...index.batches].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export async function getBatch(id: string): Promise<BatchDetailRecord | null> {
  try {
    return JSON.parse(await readFile(detailPath(id), 'utf-8')) as BatchDetailRecord
  } catch {
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
  await atomicWrite(detailPath(id), updated)
  const index = await readIndex()
  upsertSummary(index, updated)
  await writeIndex(index)
  return updated
}

export async function renameBatch(id: string, title: string): Promise<BatchDetailRecord | null> {
  const detail = await getBatch(id)
  if (!detail) return null
  const updated = recompute({ ...detail, title: title.trim() || detail.title }, new Date().toISOString())
  await atomicWrite(detailPath(id), updated)
  const index = await readIndex()
  upsertSummary(index, updated)
  await writeIndex(index)
  return updated
}
