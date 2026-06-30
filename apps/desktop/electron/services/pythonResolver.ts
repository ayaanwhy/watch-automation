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
