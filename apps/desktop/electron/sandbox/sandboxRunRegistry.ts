// SandboxRun registry (Phase 15.0) — persistence for the Sandbox-level
// grouping abstraction (see ../../src/sandbox/types/sandboxRun.ts for why
// this exists separately from Legacy's Batch).
//
// Mirrors ../services/batchRegistry.ts's storage shape deliberately —
// index.json + one detail file per record, atomic writes, index rebuilt
// from detail files if missing/corrupt — but is its OWN, entirely separate
// store: userData/sandbox-runs/, never userData/batches/. This is a new
// directory, not a new field on the existing batch registry, so Legacy's
// storage format is completely untouched by Sandbox existing.
//
// Unlike batchRegistry.ts, there is no derived-model layer here (no
// batchModel-equivalent) — a SandboxRun's status/pipelines are set
// directly by whoever is driving it (the 15.3 execution orchestrator),
// since Sandbox's workflow doesn't have Legacy's per-stage
// currentStage/nextStage derivation to replicate.
import { app } from 'electron'
import { readFile, readdir, mkdir, rename } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger'
import { atomicWriteJson } from '../services/atomicFile'
import type { SandboxRunDetail, SandboxRunSummary } from '../../src/sandbox/types/sandboxRun'
import type { SandboxProductType } from '../../src/sandbox/types/sandboxProduct'

const REGISTRY_VERSION = 1

interface SandboxRunIndex {
  version: number
  nextSeq: number
  runs: SandboxRunSummary[]
}

function sandboxRunsDir(): string {
  return join(app.getPath('userData'), 'sandbox-runs')
}
function indexPath(): string {
  return join(sandboxRunsDir(), 'index.json')
}
function detailPath(id: string): string {
  return join(sandboxRunsDir(), `${id}.json`)
}

function summarize(detail: SandboxRunDetail): SandboxRunSummary {
  const { pipelines: _pipelines, universalConfig: _universalConfig, ...summary } = detail
  return summary
}

async function quarantineCorruptFile(path: string): Promise<void> {
  try {
    const quarantineDir = join(sandboxRunsDir(), 'quarantine')
    await mkdir(quarantineDir, { recursive: true })
    await rename(path, join(quarantineDir, `${basename(path)}.${Date.now()}.corrupt`))
    logger.error(`sandbox-run-registry — quarantined unreadable file: ${path}`)
  } catch (err) {
    logger.error(`sandbox-run-registry — failed to quarantine ${path}`, err)
  }
}

async function rebuildIndexFromDetails(): Promise<SandboxRunIndex> {
  let files: string[]
  try {
    files = await readdir(sandboxRunsDir())
  } catch {
    return { version: REGISTRY_VERSION, nextSeq: 1, runs: [] }
  }
  const detailFiles = files.filter(f => f.endsWith('.json') && f !== 'index.json')

  const runs: SandboxRunSummary[] = []
  let maxSeq = 0
  for (const file of detailFiles) {
    const path = join(sandboxRunsDir(), file)
    try {
      const detail = JSON.parse(await readFile(path, 'utf-8')) as SandboxRunDetail
      runs.push(summarize(detail))
      maxSeq = Math.max(maxSeq, detail.seq)
    } catch (err) {
      logger.error(`sandbox-run-registry — corrupt sandbox run detail file: ${file}`, err)
      await quarantineCorruptFile(path)
    }
  }
  return { version: REGISTRY_VERSION, nextSeq: maxSeq + 1, runs }
}

async function readIndex(): Promise<SandboxRunIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(), 'utf-8')) as SandboxRunIndex
    if (!parsed || !Array.isArray(parsed.runs) || typeof parsed.nextSeq !== 'number') {
      throw new Error('malformed sandbox run index')
    }
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.error('sandbox-run-registry — failed to read index.json, rebuilding from detail files', err)
    }
    return rebuildIndexFromDetails()
  }
}

async function writeIndex(index: SandboxRunIndex): Promise<void> {
  await mkdir(sandboxRunsDir(), { recursive: true })
  await atomicWriteJson(indexPath(), index)
}

async function writeDetail(detail: SandboxRunDetail): Promise<void> {
  await mkdir(sandboxRunsDir(), { recursive: true })
  await atomicWriteJson(detailPath(detail.id), detail)
}

export async function listSandboxRuns(): Promise<SandboxRunSummary[]> {
  const index = await readIndex()
  return index.runs
}

export async function getSandboxRun(id: string): Promise<SandboxRunDetail | null> {
  try {
    const raw = await readFile(detailPath(id), 'utf-8')
    return JSON.parse(raw) as SandboxRunDetail
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.error(`sandbox-run-registry — failed to read sandbox run ${id}`, err)
      await quarantineCorruptFile(detailPath(id))
    }
    return null
  }
}

export interface CreateSandboxRunInput {
  title: string
  temporaryBatchId: string
  productTypes: SandboxProductType[]
}

export async function createSandboxRun(input: CreateSandboxRunInput): Promise<SandboxRunDetail> {
  const index = await readIndex()
  const now = new Date().toISOString()
  const detail: SandboxRunDetail = {
    id: randomUUID(),
    seq: index.nextSeq,
    title: input.title,
    status: 'draft',
    temporaryBatchId: input.temporaryBatchId,
    productTypes: input.productTypes,
    createdAt: now,
    updatedAt: now,
    pipelines: input.productTypes.map(productType => ({
      productType,
      batchId: null,
      status: 'draft',
      error: null,
    })),
    universalConfig: {},
  }

  await writeDetail(detail)
  index.nextSeq += 1
  index.runs = [summarize(detail), ...index.runs]
  await writeIndex(index)

  return detail
}

export type SandboxRunPatch = Partial<
  Pick<SandboxRunDetail, 'status' | 'pipelines' | 'universalConfig'>
>

export async function updateSandboxRun(id: string, patch: SandboxRunPatch): Promise<SandboxRunDetail | null> {
  const existing = await getSandboxRun(id)
  if (!existing) return null

  const updated: SandboxRunDetail = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  await writeDetail(updated)

  const index = await readIndex()
  index.runs = index.runs.map(r => (r.id === id ? summarize(updated) : r))
  await writeIndex(index)

  return updated
}
