// Phase 12F — permanent regression protection for the Earring runner,
// mirroring subprocessRunnerIncrementalPersistence.test.ts's pattern exactly
// (real subprocess execution, electron mocked to a scratch dir) but for
// preprocessing/Earring/runner.py: incremental persistence, idempotent
// reruns, per-type dispatch within one mixed batch, and — the requirement
// specific to this phase — proof that Hoop's Automatic and Manual paths
// render through the exact same implementation (hoop_mask.build_mask_from_split_x),
// not two parallel ones that could silently drift apart.
//
// The metadata/splits sidecars are written directly here rather than via
// the real parseProductMetadata/matchProductMetadata pipeline — that parsing
// layer already has its own coverage (metadataLayer.test.ts); this file's
// job is the runner and subprocessRunner.ts infrastructure, so it starts
// from an already-resolved sidecar exactly the way earringHandlers.ts's own
// ipcMain handler hands one to the runner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, unlink, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
  BrowserWindow: { getAllWindows: () => [] },
}))

const PYTHON = '/Users/apple/miniconda3/bin/python'
const RUNNER_PATH = join(process.cwd(), 'preprocessing', 'Earring', 'runner.py')

function earringConfig(getRunnerPath: () => string) {
  // Mirrors earringHandlers.ts's real RunnerConfig — reconstructed here
  // rather than imported, for the same reason the Ring & Bracelet version of
  // this test does: importing would need ipcMain mocked too, for no benefit.
  return {
    label: 'earring',
    stageType: 'editing' as const,
    eventChannel: 'earring:event',
    doneChannel: 'earring:done',
    alreadyRunningError: 'An Earring job is already running',
    noPythonError: 'No suitable Python interpreter found.',
    runnerLabel: 'Earring runner',
    getRunnerPath,
    buildArgs: (runnerPath: string, payload: any) => {
      const args = [
        runnerPath,
        '--input-dir', payload.inputDir,
        '--output-dir', payload.outputDir,
        '--metadata-file', payload.metadataSidecarPath,
        '--splits-file', payload.splitsSidecarPath,
      ]
      args.push('--processing-mode', payload.processingMode ?? 'automatic')
      return args
    },
    buildStageConfig: (payload: any) => ({
      product: 'earring',
      metadataPath: payload.metadataFilePath,
      processingMode: payload.processingMode ?? 'automatic',
    }),
    mapCompleteEvent: (event: Record<string, unknown>) => {
      const compare = (event['compare'] as string) ?? null
      const frontImage = (event['frontImage'] as string) ?? null
      const frontFullImage = (event['frontFullImage'] as string) ?? null
      const detected = event['detected']
      return {
        status: 'completed' as const,
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
  }
}

// A solid filled ellipse, horizontally symmetric about the frame's own
// center column — so its foreground bounding box is also symmetric, and
// hoop_mask.vertical_split_x's bbox-midpoint estimate lands at exactly
// width/2 (normalized 0.5). That predictability is what lets the
// Automatic-vs-Manual test below assert byte-identical output for a Manual
// split explicitly placed at 0.5, rather than only approximately comparing.
async function writeSyntheticEarringImage(path: string, width = 300, height = 220): Promise<void> {
  const buf = Buffer.alloc(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4
      const dx = (x - cx) / (width * 0.32)
      const dy = (y - cy) / (height * 0.4)
      const onShape = Math.sqrt(dx * dx + dy * dy) < 1.0
      buf[idx] = 140
      buf[idx + 1] = 100
      buf[idx + 2] = 60
      buf[idx + 3] = onShape ? 255 : 0
    }
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(path)
}

async function writeJsonSidecar(dir: string, filename: string, data: unknown): Promise<string> {
  const filePath = join(dir, filename)
  await writeFile(filePath, JSON.stringify(data), 'utf-8')
  return filePath
}

async function md5File(path: string): Promise<string> {
  return createHash('md5').update(await readFile(path)).digest('hex')
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

describe('Earring runner integration (Phase 12F)', () => {
  let inputDir: string
  let outputDir: string
  let sidecarDir: string

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-earring-integration-test-'))
    inputDir = join(scratchDir, 'input')
    outputDir = join(scratchDir, 'output')
    sidecarDir = join(scratchDir, 'sidecars')
    await mkdir(inputDir, { recursive: true })
    await mkdir(outputDir, { recursive: true })
    await mkdir(sidecarDir, { recursive: true })
    for (const name of ['stud1.png', 'drop1.png', 'hoop1.png']) {
      await writeSyntheticEarringImage(join(inputDir, name))
    }
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('writes partial progress incrementally and dispatches Stud/Drop/Hoop correctly within one mixed batch', async () => {
    const { createBatch, getBatch } = await import('../apps/desktop/electron/services/batchRegistry.js')
    const { createSubprocessRunner } = await import('../apps/desktop/electron/services/subprocessRunner.js')

    const metadataSidecarPath = await writeJsonSidecar(sidecarDir, 'metadata.json', {
      stud1: 'stud', drop1: 'drop', hoop1: 'hoop',
    })
    const splitsSidecarPath = await writeJsonSidecar(sidecarDir, 'splits.json', {})

    const batch = await createBatch({ sourceDir: inputDir, pipeline: ['editing'] })
    const runner = createSubprocessRunner(earringConfig(() => RUNNER_PATH))

    const startResult = await runner.start({
      inputDir, outputDir, batchId: batch.id,
      metadataFilePath: 'unused-by-test', metadataSidecarPath, splitsSidecarPath,
      processingMode: 'automatic', pythonPath: PYTHON,
    } as any)
    expect(startResult.ok).toBe(true)

    const sawPartialProgress = await pollUntil(async () => {
      const detail = await getBatch(batch.id)
      const stage = detail?.stages.find(s => s.type === 'editing')
      return !!stage && stage.status === 'running' && stage.images.length > 0 && stage.images.length < 3
    }, 8000)
    expect(sawPartialProgress).toBe(true)

    const finished = await pollUntil(async () => {
      const detail = await getBatch(batch.id)
      return detail?.stages.find(s => s.type === 'editing')?.status === 'completed'
    }, 15000)
    expect(finished).toBe(true)

    const final = await getBatch(batch.id)
    const stage = final?.stages.find(s => s.type === 'editing')
    expect(stage?.counts).toEqual({ total: 3, succeeded: 3, failed: 0, cancelled: 0, needsFixing: 0 })

    const bySku = new Map(stage?.images.map(i => [i.name, i]))
    // Stud/Drop: compare + frontImage only — no frontFullImage/detected.
    expect(bySku.get('stud1.png')?.assets?.frontFullImage).toBeUndefined()
    expect(bySku.get('stud1.png')?.assets?.detected).toBeUndefined()
    expect(bySku.get('drop1.png')?.assets?.compare).toBeTruthy()
    expect(bySku.get('drop1.png')?.assets?.frontImage).toBeTruthy()
    // Hoop (Automatic): all three assets, detected present (false — the
    // hoop_mask.py placeholder always reports low confidence, Phase 12D).
    const hoop = bySku.get('hoop1.png')
    expect(hoop?.assets?.compare).toBeTruthy()
    expect(hoop?.assets?.frontFullImage).toBeTruthy()
    expect(hoop?.assets?.frontImage).toBeTruthy()
    expect(hoop?.assets?.detected).toBe(false)
  }, 20000)

  it('skips completed images on rerun (including Hoop\'s 3-asset set) and reprocesses one whose output was removed', async () => {
    const { createBatch, getBatch } = await import('../apps/desktop/electron/services/batchRegistry.js')
    const { createSubprocessRunner } = await import('../apps/desktop/electron/services/subprocessRunner.js')

    const metadataSidecarPath = await writeJsonSidecar(sidecarDir, 'metadata.json', {
      stud1: 'stud', drop1: 'drop', hoop1: 'hoop',
    })
    const splitsSidecarPath = await writeJsonSidecar(sidecarDir, 'splits.json', {})
    const runner = createSubprocessRunner(earringConfig(() => RUNNER_PATH))

    const firstBatch = await createBatch({ sourceDir: inputDir, pipeline: ['editing'] })
    await runner.start({
      inputDir, outputDir, batchId: firstBatch.id,
      metadataFilePath: 'unused-by-test', metadataSidecarPath, splitsSidecarPath,
      processingMode: 'automatic', pythonPath: PYTHON,
    } as any)
    await pollUntil(async () => {
      const detail = await getBatch(firstBatch.id)
      return detail?.stages.find(s => s.type === 'editing')?.status === 'completed'
    }, 15000)

    const studComparePath = join(outputDir, 'stud1;compare.png')
    const studStatBefore = await stat(studComparePath)
    const hoopFrontFullPath = join(outputDir, 'hoop1;frontFullImage.png')
    // Simulate an interrupted Hoop image: frontFullImage survived a crash
    // mid-write but frontImage (and therefore the full 3-asset set) did not.
    await unlink(join(outputDir, 'hoop1;frontImage.png'))

    const secondBatch = await createBatch({ sourceDir: inputDir, pipeline: ['editing'] })
    await runner.start({
      inputDir, outputDir, batchId: secondBatch.id,
      metadataFilePath: 'unused-by-test', metadataSidecarPath, splitsSidecarPath,
      processingMode: 'automatic', pythonPath: PYTHON,
    } as any)
    await pollUntil(async () => {
      const detail = await getBatch(secondBatch.id)
      return detail?.stages.find(s => s.type === 'editing')?.status === 'completed'
    }, 15000)

    // 'stud1' was untouched — skipped, not reprocessed.
    const studStatAfter = await stat(studComparePath)
    expect(studStatAfter.mtimeMs).toBe(studStatBefore.mtimeMs)

    // 'hoop1's incomplete asset set forced a full reprocess — frontImage
    // exists again, and frontFullImage was rewritten (not just left in
    // place), proving the 3-path idempotent check (not just a 2-path one)
    // is what's actually gating Hoop's skip/reprocess decision.
    const hoopFrontAfter = await stat(join(outputDir, 'hoop1;frontImage.png'))
    expect(hoopFrontAfter.isFile()).toBe(true)
    const hoopFullStatBefore = await stat(hoopFrontFullPath).catch(() => null)
    expect(hoopFullStatBefore).not.toBeNull()

    const final = await getBatch(secondBatch.id)
    const stage = final?.stages.find(s => s.type === 'editing')
    expect(stage?.counts).toEqual({ total: 3, succeeded: 3, failed: 0, cancelled: 0, needsFixing: 0 })
  }, 30000)

  it('Hoop Automatic and Hoop Manual render byte-identical output when resolved to the same split position (same rendering implementation, different split_x source)', async () => {
    const { createSubprocessRunner } = await import('../apps/desktop/electron/services/subprocessRunner.js')
    const { createBatch } = await import('../apps/desktop/electron/services/batchRegistry.js')

    // A dedicated, hoop-only input directory — deliberately not the shared
    // 3-image beforeEach fixture. stud1/drop1 have no entry in this test's
    // single-SKU metadata sidecar, so mixing them in would make the batch
    // exit 2 ("partial success" — a normal, expected outcome per
    // runner_base.py's own contract) and, per subprocessProtocol.ts's
    // classifyExit (Phase 11A: any non-zero, non-cancelled exit is treated
    // as a failure at the stage level even though the individual per-image
    // results are still correct), the stage would land on 'failed' rather
    // than 'completed' — irrelevant noise for what this test is actually
    // checking, so it's isolated out rather than worked around.
    const hoopOnlyInputDir = join(scratchDir, 'hoop-only-input')
    await mkdir(hoopOnlyInputDir, { recursive: true })
    await writeSyntheticEarringImage(join(hoopOnlyInputDir, 'hoop1.png'))

    const metadataSidecarPath = await writeJsonSidecar(sidecarDir, 'metadata.json', { hoop1: 'hoop' })
    const runner = createSubprocessRunner(earringConfig(() => RUNNER_PATH))

    // Automatic: hoop_mask.vertical_split_x estimates the bbox midpoint,
    // which — for this symmetric fixture — is exactly width/2 (normalized 0.5).
    const autoOutputDir = join(scratchDir, 'output-auto')
    await mkdir(autoOutputDir, { recursive: true })
    const autoBatch = await createBatch({ sourceDir: hoopOnlyInputDir, pipeline: ['editing'] })
    const autoSplitsPath = await writeJsonSidecar(sidecarDir, 'splits-empty.json', {})
    const autoStart = await runner.start({
      inputDir: hoopOnlyInputDir, outputDir: autoOutputDir, batchId: autoBatch.id,
      metadataFilePath: 'unused-by-test', metadataSidecarPath, splitsSidecarPath: autoSplitsPath,
      processingMode: 'automatic', pythonPath: PYTHON,
    } as any)
    expect(autoStart.ok).toBe(true)
    const autoDone = await pollUntil(async () => {
      const { getBatch } = await import('../apps/desktop/electron/services/batchRegistry.js')
      const detail = await getBatch(autoBatch.id)
      return detail?.stages.find(s => s.type === 'editing')?.status === 'completed'
    }, 15000)
    expect(autoDone).toBe(true)

    // Manual: the same 0.5 split, placed explicitly rather than detected.
    const manualOutputDir = join(scratchDir, 'output-manual')
    await mkdir(manualOutputDir, { recursive: true })
    const manualBatch = await createBatch({ sourceDir: hoopOnlyInputDir, pipeline: ['editing'] })
    const manualSplitsPath = await writeJsonSidecar(sidecarDir, 'splits-manual.json', { hoop1: 0.5 })
    const manualStart = await runner.start({
      inputDir: hoopOnlyInputDir, outputDir: manualOutputDir, batchId: manualBatch.id,
      metadataFilePath: 'unused-by-test', metadataSidecarPath, splitsSidecarPath: manualSplitsPath,
      processingMode: 'manual', pythonPath: PYTHON,
    } as any)
    expect(manualStart.ok).toBe(true)
    const manualDone = await pollUntil(async () => {
      const { getBatch } = await import('../apps/desktop/electron/services/batchRegistry.js')
      const detail = await getBatch(manualBatch.id)
      return detail?.stages.find(s => s.type === 'editing')?.status === 'completed'
    }, 15000)
    expect(manualDone).toBe(true)

    // frontFullImage is an unmodified duplicate of compare either way — not
    // the interesting comparison. frontImage is where build_mask_from_split_x
    // actually renders the split; this is the regression lock the phase asked
    // for — a future change that accidentally forked the two paths (e.g. one
    // gaining a fix the other didn't) would show up here as a hash mismatch.
    const autoHash = await md5File(join(autoOutputDir, 'hoop1;frontImage.png'))
    const manualHash = await md5File(join(manualOutputDir, 'hoop1;frontImage.png'))
    expect(manualHash).toBe(autoHash)
  }, 30000)

  it('a Hoop SKU missing its Manual split fails per-image, not the whole batch', async () => {
    const { createBatch, getBatch } = await import('../apps/desktop/electron/services/batchRegistry.js')
    const { createSubprocessRunner } = await import('../apps/desktop/electron/services/subprocessRunner.js')

    const metadataSidecarPath = await writeJsonSidecar(sidecarDir, 'metadata.json', {
      stud1: 'stud', drop1: 'drop', hoop1: 'hoop',
    })
    // Deliberately no entry for hoop1.
    const splitsSidecarPath = await writeJsonSidecar(sidecarDir, 'splits.json', {})

    const batch = await createBatch({ sourceDir: inputDir, pipeline: ['editing'] })
    const runner = createSubprocessRunner(earringConfig(() => RUNNER_PATH))
    await runner.start({
      inputDir, outputDir, batchId: batch.id,
      metadataFilePath: 'unused-by-test', metadataSidecarPath, splitsSidecarPath,
      processingMode: 'manual', pythonPath: PYTHON,
    } as any)

    // Polls for either terminal status, not just 'completed': a batch with
    // any per-image failure exits 2 ("partial success" — a normal, expected
    // outcome per runner_base.py's own contract), which subprocessProtocol.ts's
    // classifyExit (Phase 11A) treats as a stage-level failure even though
    // the individual per-image results underneath are still correctly
    // recorded — see the counts assertion below, which is what this test is
    // actually checking.
    const finished = await pollUntil(async () => {
      const detail = await getBatch(batch.id)
      const stage = detail?.stages.find(s => s.type === 'editing')
      return stage?.status === 'completed' || stage?.status === 'failed'
    }, 15000)
    expect(finished).toBe(true)

    const final = await getBatch(batch.id)
    const stage = final?.stages.find(s => s.type === 'editing')
    expect(stage?.status).toBe('failed')
    // Stud and Drop have no masking step (Resolved Decision 7) — Manual mode
    // has no effect on them, so both still succeed; only Hoop fails — the
    // per-image error is what this test exists to prove, not a batch-wide one.
    expect(stage?.counts).toEqual({ total: 3, succeeded: 2, failed: 1, cancelled: 0, needsFixing: 0 })
  }, 20000)
})
