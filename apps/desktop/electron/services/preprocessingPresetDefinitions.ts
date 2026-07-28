import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../logger'
import { atomicWriteJson } from './atomicFile'
import { factoryPresetDefinitions } from '../../src/constants/preprocessingPresets'
import type {
  PreprocessingPreset,
  PreprocessingPresetValues,
  PreprocessingPresetDefinition,
  PreprocessingPresetDefinitions,
} from '../../src/constants/preprocessingPresets'

function definitionsFilePath(): string {
  return join(app.getPath('userData'), 'preprocessing-preset-definitions.json')
}

// In-memory cache — the active (possibly user-edited) preset definitions.
// preprocessHandlers.ts's buildArgs/buildStageConfig read this synchronously
// when a job starts (subprocessRunner.ts's buildArgs contract is sync), so
// the cache must be hydrated once at app startup, before the window opens
// and before any job could possibly start — see main.ts.
let _cache: PreprocessingPresetDefinitions | null = null

async function loadFromDisk(): Promise<PreprocessingPresetDefinitions | null> {
  try {
    const raw = await readFile(definitionsFilePath(), 'utf-8')
    return JSON.parse(raw) as PreprocessingPresetDefinitions
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('preprocessing-preset-definitions.json — failed to read', err)
    }
    return null
  }
}

export async function hydratePresetDefinitions(): Promise<void> {
  _cache = (await loadFromDisk()) ?? factoryPresetDefinitions()
}

// Synchronous by design — see the _cache comment above. Falls back to
// factory defaults if somehow called before hydration (shouldn't happen in
// practice; main.ts awaits hydratePresetDefinitions() before createWindow()).
export function getPresetDefinitions(): PreprocessingPresetDefinitions {
  if (_cache === null) {
    logger.warn('preprocessingPresetDefinitions — read before hydration; using factory defaults')
    _cache = factoryPresetDefinitions()
  }
  return _cache
}

export function getPresetDefinition(preset: PreprocessingPreset): PreprocessingPresetDefinition {
  return getPresetDefinitions()[preset]
}

// Saving increments that preset's version — including a "Reset to default"
// save, since that's still a change to the persisted definition. Only the
// edited preset's version advances; the other two are untouched.
export async function savePresetDefinition(
  preset: PreprocessingPreset,
  values: PreprocessingPresetValues,
): Promise<PreprocessingPresetDefinition> {
  const current = getPresetDefinitions()
  const updated: PreprocessingPresetDefinition = { ...values, version: current[preset].version + 1 }
  const next: PreprocessingPresetDefinitions = { ...current, [preset]: updated }
  _cache = next
  try {
    await atomicWriteJson(definitionsFilePath(), next)
  } catch (err) {
    logger.warn('preprocessing-preset-definitions.json — failed to write', err)
  }
  return updated
}
