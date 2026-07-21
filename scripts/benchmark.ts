#!/usr/bin/env tsx
// Phase 11 benchmarking — standalone, dev-only. Never imported by, and never
// imports from, the Electron app runtime: it drives the app's existing
// standalone entry points (src/cli/processWatch.ts, electron_runner.py,
// RingBracelet/runner.py) as external subprocesses, exactly like a user's
// own machine would run them outside the GUI.
//
// Usage:
//   npm run benchmark -- --label baseline
//   npm run benchmark -- --label phase11-final
//   npm run benchmark -- --label baseline --input-dir /path/to/real/photos --count 5
//
// Startup time is intentionally not measured — too environment-dependent
// (disk cache state, first-run model loads, etc.) to give a reliable
// architectural before/after signal.

import { Command } from 'commander'
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync, copyFileSync,
} from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i

// ── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command()
program
  .name('benchmark')
  .description('Capture a Phase 11 before/after performance + size snapshot')
  .requiredOption('--label <name>', 'e.g. "baseline" or "phase11-final"')
  .option('--input-dir <path>', 'real images to benchmark against (default: synthetic fixtures)')
  .option('--count <n>', 'images per pipeline run', (v) => Number.parseInt(v, 10), 3)
program.parse()
const opts = program.opts<{ label: string; inputDir?: string; count: number }>()

// ── Repository statistics (tracked files only — naturally excludes
//    node_modules, build output, __pycache__, models/, etc. via .gitignore) ──

function gitLsFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean)
}

function countLines(absPath: string): number {
  try {
    const content = readFileSync(absPath, 'utf-8')
    if (content.length === 0) return 0
    return content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
  } catch {
    return 0
  }
}

function computeRepoStats(files: string[]) {
  const sourceFiles = { ts: 0, tsx: 0, py: 0 }
  const linesOfCode = { ts: 0, tsx: 0, py: 0 }
  for (const f of files) {
    const ext = extname(f)
    const key = ext === '.ts' ? 'ts' : ext === '.tsx' ? 'tsx' : ext === '.py' ? 'py' : null
    if (!key) continue
    sourceFiles[key]++
    linesOfCode[key] += countLines(join(ROOT, f))
  }
  return {
    trackedFiles: files.length,
    sourceFiles: { ...sourceFiles, total: sourceFiles.ts + sourceFiles.tsx + sourceFiles.py },
    linesOfCode: { ...linesOfCode, total: linesOfCode.ts + linesOfCode.tsx + linesOfCode.py },
  }
}

// ── Project size, broken down by the areas Phase 11 is restructuring ────────

const SIZE_AREAS = [
  'apps/desktop/src',
  'apps/desktop/electron',
  'packages/processing/src',
  'preprocessing/UBG',
  'preprocessing/RingBracelet',
] as const

function computeProjectSize(files: string[]) {
  const byArea: Record<string, number> = Object.fromEntries(SIZE_AREAS.map(a => [a, 0]))
  let totalBytes = 0
  for (const f of files) {
    let size: number
    try {
      size = statSync(join(ROOT, f)).size
    } catch {
      continue // e.g. a broken symlink
    }
    totalBytes += size
    const area = SIZE_AREAS.find(a => f === a || f.startsWith(a + '/'))
    if (area) byArea[area] += size
  }
  const mb = (b: number) => Number((b / 1_048_576).toFixed(2))
  return {
    totalBytes,
    totalMb: mb(totalBytes),
    byArea: Object.fromEntries(Object.entries(byArea).map(([k, v]) => [k, mb(v)])),
  }
}

// ── Build time ────────────────────────────────────────────────────────────

function timeProductionBuild(): number {
  const start = Date.now()
  const res = spawnSync('npx', ['electron-vite', 'build'], {
    cwd: join(ROOT, 'apps/desktop'),
    encoding: 'utf-8',
  })
  if (res.status !== 0) {
    throw new Error(`production build failed:\n${res.stderr ?? res.stdout}`)
  }
  return Date.now() - start
}

// ── Python interpreter resolution (standalone re-derivation of
//    pythonResolver.ts's candidate order — that module is Electron-coupled
//    via app.getPath, so it isn't reused directly here) ─────────────────────

function resolvePython(): string {
  const condaPrefix = process.env['CONDA_PREFIX']
  const candidates = [
    ...(condaPrefix ? [join(condaPrefix, 'bin', 'python3')] : []),
    join(homedir(), 'miniconda3', 'bin', 'python3'),
    join(homedir(), 'miniforge3', 'bin', 'python3'),
    join(homedir(), 'anaconda3', 'bin', 'python3'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  try {
    const which = execFileSync('/usr/bin/which', ['python3'], { encoding: 'utf-8' }).trim()
    if (which) return which
  } catch { /* fall through to error below */ }
  throw new Error('No Python interpreter found — set CONDA_PREFIX or ensure python3 is on PATH')
}

// ── Timed subprocess execution with peak RSS (macOS/Linux) ──────────────────

interface TimedRun {
  wallTimeMs: number
  peakRssMb: number | null
  exitCode: number | null
  stderr: string
}

function runTimed(cmd: string, args: string[], cwd?: string): TimedRun {
  const plat = platform()
  const start = Date.now()
  let res: SpawnSyncReturns<string>
  let peakRssMb: number | null = null

  if (plat === 'darwin') {
    res = spawnSync('/usr/bin/time', ['-l', cmd, ...args], { cwd, encoding: 'utf-8' })
    const m = res.stderr?.match(/(\d+)\s+maximum resident set size/)
    if (m) peakRssMb = Number(m[1]) / 1_048_576 // macOS reports bytes
  } else if (plat === 'linux') {
    res = spawnSync('/usr/bin/time', ['-v', cmd, ...args], { cwd, encoding: 'utf-8' })
    const m = res.stderr?.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)
    if (m) peakRssMb = Number(m[1]) / 1024 // GNU time reports KB
  } else {
    res = spawnSync(cmd, args, { cwd, encoding: 'utf-8' })
  }

  return {
    wallTimeMs: Date.now() - start,
    peakRssMb: peakRssMb !== null ? Number(peakRssMb.toFixed(1)) : null,
    exitCode: res.status,
    stderr: res.stderr ?? '',
  }
}

// ── Synthetic fixtures (used whenever --input-dir is not given) ─────────────

async function solidSegment(width: number, height: number, background: { r: number; g: number; b: number; alpha: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer()
}

// Mirrors tests/knownGoodProcessing.test.ts's createSolidWatch fixture shape
// (left strap / dial / right strap) — same production code path, different
// purpose (timing, not correctness assertions).
async function generateSyntheticWatchImages(dir: string, count: number) {
  mkdirSync(dir, { recursive: true })
  const leftWidth = 300, dialWidth = 800, rightWidth = 300, height = 700
  const jobs: { path: string; widthMm: number; leftBoundary: number; rightBoundary: number }[] = []
  for (let i = 0; i < count; i++) {
    const path = join(dir, `watch-${i}.png`)
    const [left, dial, right] = await Promise.all([
      solidSegment(leftWidth, height, { r: 120, g: 40, b: 40, alpha: 1 }),
      solidSegment(dialWidth, height, { r: 40, g: 120, b: 40, alpha: 1 }),
      solidSegment(rightWidth, height, { r: 40, g: 40, b: 120, alpha: 1 }),
    ])
    await sharp({ create: { width: leftWidth + dialWidth + rightWidth, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: dial, left: leftWidth, top: 0 },
        { input: right, left: leftWidth + dialWidth, top: 0 },
      ])
      .png().toFile(path)
    jobs.push({ path, widthMm: 44, leftBoundary: leftWidth, rightBoundary: leftWidth + dialWidth })
  }
  return jobs
}

// Generic product-photo stand-in for the UBG / Ring & Bracelet pipelines —
// these two just walk a folder of images, no per-image metadata needed.
async function generateSyntheticProductImages(dir: string, count: number) {
  mkdirSync(dir, { recursive: true })
  const width = 1600, height = 1200
  for (let i = 0; i < count; i++) {
    const objW = Math.round(width * 0.5), objH = Math.round(height * 0.5)
    const obj = await sharp({
      create: { width: objW, height: objH, channels: 4, background: { r: 70 + i * 15, g: 90, b: 110, alpha: 1 } },
    }).png().toBuffer()
    await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite([{ input: obj, left: Math.round(width * 0.25), top: Math.round(height * 0.25) }])
      .png().toFile(join(dir, `sample-${i}.png`))
  }
}

// Real images: copy the first `count` into a scratch dir so a large
// --input-dir doesn't turn a "lightweight" run into a full production batch.
function collectRealImages(sourceDir: string, destDir: string, count: number): string[] {
  mkdirSync(destDir, { recursive: true })
  const names = readdirSync(sourceDir).filter(f => IMAGE_EXT_RE.test(f)).slice(0, count)
  if (names.length === 0) throw new Error(`No images found in ${sourceDir}`)
  for (const name of names) copyFileSync(join(sourceDir, name), join(destDir, name))
  return names.map(n => join(destDir, n))
}

// Heuristic-only boundaries for real photos in --input-dir mode: this is
// purely for exercising realistic image content during timing, NOT a
// correctness fixture — a real batch's actual boundaries always come from
// user annotation, which a bare folder of images doesn't carry.
async function realWatchJobs(paths: string[]) {
  const jobs: { path: string; widthMm: number; leftBoundary: number; rightBoundary: number }[] = []
  for (const path of paths) {
    const meta = await sharp(path).metadata()
    const w = meta.width ?? 1000
    jobs.push({ path, widthMm: 42, leftBoundary: Math.round(w * 0.2), rightBoundary: Math.round(w * 0.8) })
  }
  return jobs
}

// ── Pipeline benchmarks ───────────────────────────────────────────────────

async function benchmarkWatch(scratch: string, count: number, inputDir: string | undefined) {
  const jobs = inputDir
    ? await realWatchJobs(collectRealImages(inputDir, join(scratch, 'watch-in'), count))
    : await generateSyntheticWatchImages(join(scratch, 'watch-in'), count)

  const outDir = join(scratch, 'watch-out')
  mkdirSync(outDir, { recursive: true })

  let wallTimeMs = 0
  let peakRssMb: number | null = null
  for (const job of jobs) {
    const outputPath = join(outDir, `${job.path.split('/').pop()};frontImage.png`)
    const run = runTimed('npx', [
      'tsx', 'src/cli/processWatch.ts',
      '-i', job.path, '-o', outputPath,
      '-w', String(job.widthMm), '-l', String(job.leftBoundary), '-r', String(job.rightBoundary),
    ], ROOT)
    if (run.exitCode !== 0) throw new Error(`Watch processing failed:\n${run.stderr.slice(-2000)}`)
    wallTimeMs += run.wallTimeMs
    if (run.peakRssMb !== null) peakRssMb = Math.max(peakRssMb ?? 0, run.peakRssMb)
  }

  return { sampleCount: jobs.length, wallTimeMs, peakRssMb, inputSource: inputDir ? 'real' as const : 'synthetic' as const }
}

function parseLatestMpsDriverMb(profilingDir: string, afterMs: number): number | null {
  if (!existsSync(profilingDir)) return null
  const candidates = readdirSync(profilingDir)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({ f, t: statSync(join(profilingDir, f)).mtimeMs }))
    .filter(x => x.t >= afterMs)
    .sort((a, b) => b.t - a.t)
  if (candidates.length === 0) return null
  const content = readFileSync(join(profilingDir, candidates[0].f), 'utf-8')
  const matches = [...content.matchAll(/mps_driver_mb\s*:\s*([\d.]+)/g)]
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null
}

async function benchmarkUniversalPreprocessing(python: string, scratch: string, count: number, inputDir: string | undefined) {
  const inDir = join(scratch, 'ubg-in')
  if (inputDir) collectRealImages(inputDir, inDir, count)
  else await generateSyntheticProductImages(inDir, count)
  const outDir = join(scratch, 'ubg-out')
  mkdirSync(outDir, { recursive: true })

  const runnerPath = join(ROOT, 'preprocessing/UBG/electron_runner.py')
  const startMs = Date.now()
  const run = runTimed(python, [
    runnerPath, '--input-dir', inDir, '--output-dir', outDir,
    '--object-type', 'watch', '--scale-factor', '2',
  ])
  if (run.exitCode !== 0) throw new Error(`Universal Preprocessing failed:\n${run.stderr.slice(-2000)}`)

  const mpsDriverMb = parseLatestMpsDriverMb(join(ROOT, 'preprocessing/UBG/profiling'), startMs)
  return {
    sampleCount: count,
    wallTimeMs: run.wallTimeMs,
    peakRssMb: run.peakRssMb,
    mpsDriverMb,
    inputSource: inputDir ? 'real' as const : 'synthetic' as const,
  }
}

async function benchmarkRingBracelet(python: string, scratch: string, count: number, inputDir: string | undefined) {
  const inDir = join(scratch, 'rb-in')
  if (inputDir) collectRealImages(inputDir, inDir, count)
  else await generateSyntheticProductImages(inDir, count)
  const outDir = join(scratch, 'rb-out')
  mkdirSync(outDir, { recursive: true })

  const runnerPath = join(ROOT, 'preprocessing/RingBracelet/runner.py')
  // --product is arbitrary for timing purposes: runner.py currently routes
  // both 'ring' and 'bracelet' through the same generate_wrap_mask algorithm
  // (see the Phase 10E rollback note in runner.py).
  const run = runTimed(python, [runnerPath, '--input-dir', inDir, '--output-dir', outDir, '--product', 'bracelet'])
  if (run.exitCode !== 0) throw new Error(`Ring & Bracelet processing failed:\n${run.stderr.slice(-2000)}`)

  return {
    sampleCount: count,
    wallTimeMs: run.wallTimeMs,
    peakRssMb: run.peakRssMb,
    inputSource: inputDir ? 'real' as const : 'synthetic' as const,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

function gitInfo() {
  try {
    return {
      commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim(),
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim(),
    }
  } catch {
    return { commit: 'unknown', branch: 'unknown' }
  }
}

async function main() {
  console.log(`Phase 11 benchmark — label="${opts.label}", count=${opts.count}, input=${opts.inputDir ?? '(synthetic)'}`)

  const files = gitLsFiles()
  const repoStats = computeRepoStats(files)
  const projectSize = computeProjectSize(files)

  console.log('Timing production build...')
  const buildTimeMs = timeProductionBuild()

  const python = resolvePython()
  const scratch = mkdtempSync(join(tmpdir(), 'wpa-benchmark-'))

  try {
    console.log('Benchmarking Watch processing...')
    const watch = await benchmarkWatch(scratch, opts.count, opts.inputDir)

    console.log('Benchmarking Universal Preprocessing...')
    const preprocessing = await benchmarkUniversalPreprocessing(python, scratch, opts.count, opts.inputDir)

    console.log('Benchmarking Ring & Bracelet...')
    const ringBracelet = await benchmarkRingBracelet(python, scratch, opts.count, opts.inputDir)

    const result = {
      label: opts.label,
      timestamp: new Date().toISOString(),
      git: gitInfo(),
      repoStats,
      projectSize,
      buildTimeMs,
      pipelines: { watch, preprocessing, ringBracelet },
    }

    const benchmarksDir = join(ROOT, 'benchmarks')
    mkdirSync(benchmarksDir, { recursive: true })
    const outPath = join(benchmarksDir, `${opts.label}-${Date.now()}.json`)
    writeFileSync(outPath, JSON.stringify(result, null, 2))

    console.log(`\nSaved: ${outPath}`)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
