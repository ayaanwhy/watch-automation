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
import { engineDataDir } from './engine/runtime'
import { readFile, readdir, mkdir, rename } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger'
import { atomicWriteJson } from '../services/atomicFile'
import type { SandboxRunDetail, SandboxRunSummary } from '../../src/sandbox/types/sandboxRun'
import type { SandboxProductType } from '../../src/sandbox/types/sandboxProduct'
import { SANDBOX_PRODUCT_AVAILABILITY } from '../../src/sandbox/types/sandboxProduct'

const REGISTRY_VERSION = 1

// Serializes every write to this registry (Phase 15.3) — index.json is one
// shared file, and createSandboxRun/updateSandboxRun each do a real
// read-modify-write cycle against it. Once Phase 15.3 started running
// multiple SandboxRuns' product pipelines concurrently (by design — see
// sandboxOrchestrator.ts), two of those pipelines finishing at the same
// instant could race two concurrent writeIndex() calls against the same
// index.json.tmp, and the loser's rename() would fail outright (a real
// failure this surfaced, not a hypothetical). Reads (getSandboxRun,
// listSandboxRuns) are unaffected — those don't mutate shared state.
let writeQueue: Promise<unknown> = Promise.resolve()
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn, fn)
  // Swallow so one failed write doesn't permanently wedge every write
  // after it — each caller still sees/handles its own result/rejection.
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

interface SandboxRunIndex {
  version: number
  nextSeq: number
  runs: SandboxRunSummary[]
}

function sandboxRunsDir(): string {
  return join(engineDataDir(), 'sandbox-runs')
}
function indexPath(): string {
  return join(sandboxRunsDir(), 'index.json')
}
function detailPath(id: string): string {
  return join(sandboxRunsDir(), `${id}.json`)
}

// The index only needs the summary fields — the heavy per-image state (items,
// input snapshot, dispositions, ...) lives in the detail file alone.
function summarize(detail: SandboxRunDetail): SandboxRunSummary {
  const { id, seq, title, status, temporaryBatchId, productTypes, createdAt, updatedAt } = detail
  return { id, seq, title, status, temporaryBatchId, productTypes, createdAt, updatedAt }
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
  // Snapshot of the SandboxUniversalConfig that produced this run — an
  // open record here too (mirrors SandboxRunDetail.universalConfig's own
  // comment); the orchestrator's caller owns the real shape (Phase 15.2's
  // SandboxUniversalConfig), this registry only persists it opaquely.
  universalConfig: Record<string, unknown>
}

// Phase 15.3 — pipelines start 'unavailable' (terminal, no batch will ever
// be created) for a product type with no processing pipeline yet
// (Necklace/Gemstone today — see SANDBOX_PRODUCT_AVAILABILITY), 'queued'
// otherwise. Never invents a healthy status for an unavailable product.
export async function createSandboxRun(input: CreateSandboxRunInput): Promise<SandboxRunDetail> {
  return serializeWrite(async () => {
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
        status: SANDBOX_PRODUCT_AVAILABILITY[productType].available ? 'queued' : 'unavailable',
        error: SANDBOX_PRODUCT_AVAILABILITY[productType].available ? null : (SANDBOX_PRODUCT_AVAILABILITY[productType].reason ?? null),
        stage: null,
        postProcessingOutputDir: null,
        postProcessingArtifacts: [],
        failure: null,
        activity: null,
      })),
      items: [],
      universalConfig: input.universalConfig,
      cancelRequested: false,
      dispositions: {},
      handoffResults: {},
      failure: null,
      startedAt: null,
      finishedAt: null,
    }

    await writeDetail(detail)
    index.nextSeq += 1
    index.runs = [summarize(detail), ...index.runs]
    await writeIndex(index)

    return detail
  })
}

export type SandboxRunPatch = Partial<
  Pick<SandboxRunDetail, 'status' | 'pipelines' | 'items' | 'universalConfig' | 'cancelRequested' | 'dispositions' | 'handoffResults' | 'failure' | 'startedAt' | 'finishedAt' | 'inputItems'>
>

export async function updateSandboxRun(id: string, patch: SandboxRunPatch): Promise<SandboxRunDetail | null> {
  return serializeWrite(async () => {
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
  })
}
