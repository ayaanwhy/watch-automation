import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)
const IS_WIN = platform() === 'win32'

// In-memory cache — survives for the lifetime of the main process.
// Cleared only if the resolved path later fails (not implemented; acceptable for Phase 8.5A).
let _cached: string | undefined

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

async function validate(pythonPath: string): Promise<boolean> {
  try {
    await execFileAsync(pythonPath, ['-c', 'import torch, sam2, basicsr'], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

// Returns candidates in priority order: active Conda env first, then common install roots.
function staticCandidates(): string[] {
  const home = homedir()
  const condaPrefix = process.env['CONDA_PREFIX']

  if (IS_WIN) {
    return [
      ...(condaPrefix ? [join(condaPrefix, 'python.exe')] : []),
      join(home, 'miniconda3', 'python.exe'),
      join(home, 'miniforge3', 'python.exe'),
      join(home, 'anaconda3', 'python.exe'),
    ]
  }

  return [
    ...(condaPrefix ? [join(condaPrefix, 'bin', 'python3')] : []),
    join(home, 'miniconda3', 'bin', 'python3'),
    join(home, 'miniforge3', 'bin', 'python3'),
    join(home, 'anaconda3', 'bin', 'python3'),
  ]
}

async function resolveViaPath(): Promise<string | null> {
  // which/where as a last resort — may not reflect Conda envs, but catches
  // installations that are on PATH (venv, system Python with correct deps).
  const cmd = IS_WIN ? 'where' : '/usr/bin/which'
  const arg = IS_WIN ? 'python' : 'python3'
  try {
    const { stdout } = await execFileAsync(cmd, [arg], { timeout: 5_000 })
    return stdout.trim().split('\n')[0].trim() || null
  } catch {
    return null
  }
}

/**
 * Validate an explicit, renderer-supplied Python interpreter path (manual
 * override). Reuses the same existence + import checks as auto-discovery,
 * but does not consult or populate the auto-discovery cache.
 */
export async function validatePythonPath(
  pythonPath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!await fileExists(pythonPath)) {
    return { ok: false, error: `Python interpreter not found: ${pythonPath}` }
  }
  if (!await validate(pythonPath)) {
    return {
      ok: false,
      error: `Interpreter is missing required packages (torch, sam2, basicsr): ${pythonPath}`,
    }
  }
  return { ok: true }
}

/**
 * Discover and validate a Python interpreter that has the preprocessing
 * dependencies (torch, sam2, basicsr) available.
 *
 * Resolution order:
 *   macOS — $CONDA_PREFIX → ~/miniconda3 → ~/miniforge3 → ~/anaconda3 → which python3
 *   Windows — %CONDA_PREFIX% → %USERPROFILE%\miniconda3 → miniforge3 → anaconda3 → where python
 *
 * Returns the first passing interpreter path, or null if none is found.
 * Caches the result in memory for the lifetime of the process.
 */
export async function resolvePreprocessingPython(): Promise<string | null> {
  if (_cached !== undefined) return _cached

  for (const path of staticCandidates()) {
    if (!await fileExists(path)) {
      logger.info(`preprocess:resolve — not found: ${path}`)
      continue
    }
    logger.info(`preprocess:resolve — validating: ${path}`)
    if (await validate(path)) {
      logger.info(`preprocess:resolve — resolved: ${path}`)
      _cached = path
      return path
    }
    logger.warn(`preprocess:resolve — validation failed: ${path}`)
  }

  const whichPath = await resolveViaPath()
  if (whichPath && await fileExists(whichPath)) {
    logger.info(`preprocess:resolve — validating (which): ${whichPath}`)
    if (await validate(whichPath)) {
      logger.info(`preprocess:resolve — resolved via which: ${whichPath}`)
      _cached = whichPath
      return whichPath
    }
    logger.warn(`preprocess:resolve — validation failed (which): ${whichPath}`)
  }

  logger.warn('preprocess:resolve — no suitable Python interpreter found')
  return null
}

// Phase 15.7 — Sandbox's real post-processing scripts (postProcessing/*/
// runner.py) need only Pillow, not the heavyweight torch/sam2/basicsr stack
// Preprocessing's interpreter is validated against. Deliberately a SEPARATE
// resolver/cache from resolvePreprocessingPython above: a machine with
// Pillow but no torch/sam2/basicsr (or vice versa) is a real, plausible
// state, and conflating the two would make Post Processing's own
// availability depend on an unrelated capability it doesn't need. Shares
// staticCandidates()/resolveViaPath()/fileExists() — same discovery order,
// different validation.
let _postProcessingCached: string | undefined

async function validatePostProcessing(pythonPath: string): Promise<boolean> {
  try {
    await execFileAsync(pythonPath, ['-c', 'import PIL'], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Discover and validate a Python interpreter with Pillow available, for
 * Sandbox's real post-processing scripts. autoMeasurementCalculator's own
 * additional pandas/openpyxl requirement is checked separately by its own
 * adapter — capability is per-script, not one global gate (Phase 15.7
 * section 4's explicit requirement).
 */
export async function resolvePostProcessingPython(): Promise<string | null> {
  if (_postProcessingCached !== undefined) return _postProcessingCached

  for (const path of staticCandidates()) {
    if (!await fileExists(path)) continue
    if (await validatePostProcessing(path)) {
      logger.info(`postprocess:resolve — resolved: ${path}`)
      _postProcessingCached = path
      return path
    }
  }

  const whichPath = await resolveViaPath()
  if (whichPath && await fileExists(whichPath) && await validatePostProcessing(whichPath)) {
    logger.info(`postprocess:resolve — resolved via which: ${whichPath}`)
    _postProcessingCached = whichPath
    return whichPath
  }

  logger.warn('postprocess:resolve — no suitable Python interpreter found (Pillow not available)')
  return null
}

/**
 * Additional capability check beyond Pillow — used only by adapters (today:
 * autoMeasurementCalculator) whose real script also needs pandas/openpyxl
 * for spreadsheet output. Never cached: this is a one-off per-adapter
 * check, not a shared resolution path.
 */
export async function checkPythonModules(pythonPath: string, modules: string[]): Promise<boolean> {
  try {
    await execFileAsync(pythonPath, ['-c', `import ${modules.join(', ')}`], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}
