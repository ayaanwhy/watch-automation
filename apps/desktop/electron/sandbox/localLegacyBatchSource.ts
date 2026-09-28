// DEVELOPMENT/TESTING ONLY — exposes existing local Legacy Automation
// Batches as Sandbox "Temporary Batches" so the real Sandbox flow can be
// tried against real local data before the real Sandbox API exists (see
// src/sandbox/types/sandboxLocalTestBatch.ts). Expected to be removed or
// replaced by the real Temporary Batch source.
//
// STRICTLY READ-ONLY toward Legacy: batches are read through the existing
// batchRegistry (no second registry, no filesystem crawl to find them), and
// the source folder/metadata sheets are only read. The resulting
// SandboxTemporaryBatchDetail is an ordinary input to the ordinary Sandbox
// flow — the SandboxRun then materializes its own copy into its own
// Sandbox-owned workspace (sandboxWorkspace.materializeProductImages);
// nothing here copies or writes anything.
//
// The renderer never supplies a path: it only ever names a batch id
// (LOCAL_TEST_BATCH_ID_PREFIX + Legacy batch id), and every path used comes
// from the Legacy registry record resolved here in the main process.
import { engineDataDir } from './engine/runtime'
import { readdir } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { parseSpreadsheet, parseProductMetadata, matchSkus, matchProductMetadata } from '@wpa/processing/data'
import { getBatch, listBatches } from '../services/batchRegistry'
import { mapWithConcurrency } from '../services/workflowPreparation'
import { logger } from '../logger'
import { assertWithinDir } from './sandboxWorkspace'
import { classifyMatchedSkus, type EarringType } from '../../src/constants/earringClassification'
import { legacyBatchIdFromLocalTestBatchId, toLocalTestBatchId } from '../../src/sandbox/types/sandboxLocalTestBatch'
import type { SandboxLocalTestBatchListResult, SandboxLocalTestBatchSummary } from '../../src/sandbox/types/sandboxLocalTestBatch'
import type { SandboxProductType } from '../../src/sandbox/types/sandboxProduct'
import type { SandboxTemporaryBatchDetail, SandboxTemporaryBatchImage } from '../../src/sandbox/types/sandboxTemporaryBatch'
import type { BatchDetailRecord, BatchProductType } from '../../src/types/batch'

// Same set Sandbox's own 'None' preprocessing accepts (sandboxNonePreprocessing.ts).
const SUPPORTED_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg'])
const SCAN_CONCURRENCY = 8

// Legacy's BatchProductType includes 'generic' (no Sandbox pipeline) and
// null (older batches that never recorded one) — neither is guessed at.
function toSandboxProductType(legacy: BatchProductType | null): SandboxProductType | null {
  return legacy === 'watch' || legacy === 'ring' || legacy === 'bracelet' || legacy === 'earring' ? legacy : null
}

// Sandbox's own Legacy Batches (SandboxRun -> Legacy Batch grouping, Option
// B) live in the same registry; they are Sandbox output, never a valid
// source, and must not be offered back as one.
function isSandboxOwnedSourceDir(sourceDir: string): boolean {
  const sandboxRoot = resolve(join(engineDataDir(), 'sandbox-runs')) + sep
  return (resolve(sourceDir) + sep).startsWith(sandboxRoot)
}

async function listSourceImageFiles(sourceDir: string): Promise<string[]> {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && !e.name.startsWith('.') && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort()
}

function stem(filename: string): string {
  const ext = extname(filename)
  return ext ? filename.slice(0, -ext.length) : filename
}

// The one Legacy Batch -> SandboxTemporaryBatch conversion. Pure (no I/O)
// so it can be tested directly; getLocalTestBatchDetail below gathers its
// inputs. Metadata is passed through exactly where Legacy's own sheets
// supply it and left absent everywhere else — never defaulted or guessed
// (Sandbox's own normalization/validation then reports what's missing).
export interface LegacyBatchAdapterInput {
  legacyBatchId: string
  name: string
  productType: SandboxProductType
  sourceDir: string
  imageFiles: string[]
  // Watch: the batch's own spreadsheet rows, keyed by lower-cased SKU.
  watchRows?: Record<string, { widthMm: number; heightMm: number; measureBy: string }>
  // Earring: the batch's own metadata classification, keyed by lower-cased SKU.
  earringTypes?: Record<string, EarringType>
}

export function legacyBatchToSandboxTemporaryBatch(input: LegacyBatchAdapterInput): SandboxTemporaryBatchDetail {
  const seen = new Set<string>()
  const images: SandboxTemporaryBatchImage[] = []

  for (const filename of input.imageFiles) {
    const sku = stem(filename)
    const key = sku.toLowerCase()
    // Legacy treats SKUs case-insensitively and lets the first occurrence
    // win (discoverImages/matchSkus); a second file for the same SKU (e.g.
    // a.png + a.jpg) is dropped rather than processed twice.
    if (seen.has(key)) continue
    seen.add(key)

    const imagePath = join(input.sourceDir, filename)
    assertWithinDir(input.sourceDir, imagePath)

    const image: SandboxTemporaryBatchImage = { sku, imagePath, productType: input.productType }

    if (input.productType === 'watch') {
      const row = input.watchRows?.[key]
      if (row) {
        // Legacy's parser coerces an unparsable number to 0 — that is "no
        // value", not a measurement, so it is left absent.
        if (row.widthMm > 0) image.widthMm = row.widthMm
        if (row.heightMm > 0) image.heightMm = row.heightMm
        const measureBy = row.measureBy.trim().toLowerCase()
        if (measureBy === 'case') image.measureBy = 'Case'
        else if (measureBy === 'dial') image.measureBy = 'Dial'
      }
    } else if (input.productType === 'earring') {
      const earringType = input.earringTypes?.[key]
      if (earringType) image.earringType = earringType
    }

    images.push(image)
  }

  return {
    id: toLocalTestBatchId(input.legacyBatchId),
    name: input.name,
    productTypes: [input.productType],
    imageCount: images.length,
    images,
  }
}

export async function listLocalTestBatches(): Promise<SandboxLocalTestBatchListResult> {
  const summaries = await listBatches()
  const batches: SandboxLocalTestBatchSummary[] = []
  const hidden: { name: string; reason: string }[] = []

  const candidates = summaries.filter(s => !s.sourceDir || !isSandboxOwnedSourceDir(s.sourceDir))

  await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async summary => {
    const productType = toSandboxProductType(summary.productType)
    if (!productType) {
      hidden.push({ name: summary.title, reason: 'No usable product type recorded on this Legacy batch.' })
      return
    }
    if (!summary.sourceDir) {
      hidden.push({ name: summary.title, reason: 'This Legacy batch has no source folder.' })
      return
    }
    let files: string[]
    try {
      files = await listSourceImageFiles(summary.sourceDir)
    } catch {
      hidden.push({ name: summary.title, reason: 'Source folder not found (is its drive mounted?).' })
      return
    }
    if (files.length === 0) {
      hidden.push({ name: summary.title, reason: 'Source folder has no supported images.' })
      return
    }
    batches.push({
      id: toLocalTestBatchId(summary.id),
      name: summary.title,
      productTypes: [productType],
      imageCount: new Set(files.map(f => stem(f).toLowerCase())).size,
      legacyStatus: summary.status,
      createdAt: summary.createdAt,
      sourceDir: summary.sourceDir,
    })
  })

  // Newest first, matching how Legacy lists its own batches; stable output
  // regardless of the concurrent scan's completion order.
  batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  hidden.sort((a, b) => a.name.localeCompare(b.name))
  return { batches, hidden }
}

function findStageConfigString(detail: BatchDetailRecord, key: string): string | null {
  for (const stage of detail.stages) {
    const value = stage.config[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

export async function getLocalTestBatchDetail(id: string): Promise<SandboxTemporaryBatchDetail | null> {
  const legacyId = legacyBatchIdFromLocalTestBatchId(id)
  if (!legacyId) return null

  const detail = await getBatch(legacyId)
  if (!detail || !detail.sourceDir || isSandboxOwnedSourceDir(detail.sourceDir)) return null

  const productType = toSandboxProductType(detail.productType)
  if (!productType) return null

  let imageFiles: string[]
  try {
    imageFiles = await listSourceImageFiles(detail.sourceDir)
  } catch (err) {
    logger.warn(`local-test-batch — source folder unreadable for ${legacyId}: ${String(err)}`)
    return null
  }
  if (imageFiles.length === 0) return null

  // Same shape Legacy's own discoverImages produces, built from the
  // (extension-wider) file list so SKU matching keeps Legacy's exact
  // case-insensitive semantics.
  const skus = Array.from(new Map(imageFiles.map(f => [stem(f).toLowerCase(), stem(f)])).values())
  const discovered = { skus, totalCount: imageFiles.length, duplicateSkus: [] as string[] }

  let watchRows: LegacyBatchAdapterInput['watchRows']
  let earringTypes: LegacyBatchAdapterInput['earringTypes']

  if (productType === 'watch') {
    const sheetPath = findStageConfigString(detail, 'spreadsheetPath')
    if (sheetPath) {
      try {
        const parsed = parseSpreadsheet(sheetPath)
        if (parsed.errors.length === 0) {
          const match = matchSkus(parsed, discovered)
          watchRows = Object.fromEntries(Object.entries(match.rows).map(([sku, row]) => [sku.toLowerCase(), row]))
        } else {
          logger.warn(`local-test-batch — watch spreadsheet invalid for ${legacyId}: ${parsed.errors.join('; ')}`)
        }
      } catch (err) {
        logger.warn(`local-test-batch — watch spreadsheet unreadable for ${legacyId}: ${String(err)}`)
      }
    }
  } else if (productType === 'earring') {
    const metadataPath = findStageConfigString(detail, 'metadataPath')
    if (metadataPath) {
      try {
        const parsed = parseProductMetadata(metadataPath)
        if (parsed.errors.length === 0) {
          const match = matchProductMetadata(parsed, discovered)
          const { bySku } = classifyMatchedSkus(match.matched, match.rows)
          earringTypes = Object.fromEntries(Object.entries(bySku).map(([sku, type]) => [sku.toLowerCase(), type]))
        } else {
          logger.warn(`local-test-batch — earring metadata invalid for ${legacyId}: ${parsed.errors.join('; ')}`)
        }
      } catch (err) {
        logger.warn(`local-test-batch — earring metadata unreadable for ${legacyId}: ${String(err)}`)
      }
    }
  }

  return legacyBatchToSandboxTemporaryBatch({
    legacyBatchId: legacyId,
    name: detail.title,
    productType,
    sourceDir: detail.sourceDir,
    imageFiles,
    watchRows,
    earringTypes,
  })
}
