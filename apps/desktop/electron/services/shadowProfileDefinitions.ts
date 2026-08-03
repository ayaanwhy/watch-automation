import { app } from 'electron'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger'
import { atomicWriteJson } from './atomicFile'
import { factoryShadowProfileDefinitions } from '../../src/constants/shadowProfiles'
import type {
  ShadowProfileName,
  ShadowProfileValues,
  ShadowProfileDefinition,
  ShadowProfileDefinitions,
} from '../../src/constants/shadowProfiles'

// Mirrors electron/services/preprocessingPresetDefinitions.ts exactly —
// same hydrate-once/read-synchronously/atomic-write shape, same reason
// (ringBraceletHandlers.ts/earringHandlers.ts's buildStageConfig and the
// shadow-profile sidecar writer both need synchronous access once a job
// starts).
function definitionsFilePath(): string {
  return join(app.getPath('userData'), 'shadow-profile-definitions.json')
}

let _cache: ShadowProfileDefinitions | null = null

async function loadFromDisk(): Promise<ShadowProfileDefinitions | null> {
  try {
    const raw = await readFile(definitionsFilePath(), 'utf-8')
    return JSON.parse(raw) as ShadowProfileDefinitions
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('shadow-profile-definitions.json — failed to read', err)
    }
    return null
  }
}

export async function hydrateShadowProfileDefinitions(): Promise<void> {
  _cache = (await loadFromDisk()) ?? factoryShadowProfileDefinitions()
}

export function getShadowProfileDefinitions(): ShadowProfileDefinitions {
  if (_cache === null) {
    logger.warn('shadowProfileDefinitions — read before hydration; using factory defaults')
    _cache = factoryShadowProfileDefinitions()
  }
  return _cache
}

export function getShadowProfileDefinition(name: ShadowProfileName): ShadowProfileDefinition {
  return getShadowProfileDefinitions()[name]
}

// Saving increments that profile's version — including a "Reset to
// default" save, since that's still a change to the persisted definition.
// Only the edited profile's version advances; the other two are untouched.
export async function saveShadowProfileDefinition(
  name: ShadowProfileName,
  values: ShadowProfileValues,
): Promise<ShadowProfileDefinition> {
  const current = getShadowProfileDefinitions()
  const updated: ShadowProfileDefinition = { ...values, version: current[name].version + 1 }
  const next: ShadowProfileDefinitions = { ...current, [name]: updated }
  _cache = next
  try {
    await atomicWriteJson(definitionsFilePath(), next)
  } catch (err) {
    logger.warn('shadow-profile-definitions.json — failed to write', err)
  }
  return updated
}

// Written before every Ring & Bracelet / Earring job start (mirrors
// earringHandlers.ts's writeMetadataSidecar/writeSplitsSidecar convention
// exactly — a fresh temp JSON file per start, never reused) so
// RingBracelet/runner.py and Earring/runner.py can each read whichever
// profile(s) they care about via --shadow-profile-file. Always writes the
// full current set (default or customized) — the byte-identical-by-default
// guarantee holds because a never-touched definition's values are already
// identical to the Python-side hardcoded dict, not because of a
// present/absent distinction here.
export async function writeShadowProfileSidecar(): Promise<string> {
  const dir = join(app.getPath('temp'), 'wpa-shadow-profiles')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}.json`)
  const definitions = getShadowProfileDefinitions()
  const payload: Record<ShadowProfileName, ShadowProfileValues> = {
    ringBracelet: stripVersion(definitions.ringBracelet),
    earringStudDrop: stripVersion(definitions.earringStudDrop),
    earringHoop: stripVersion(definitions.earringHoop),
  }
  await writeFile(filePath, JSON.stringify(payload), 'utf-8')
  return filePath
}

function stripVersion(definition: ShadowProfileDefinition): ShadowProfileValues {
  const { version: _version, ...values } = definition
  return values
}
