// 11.5B follow-up — preprocessingPresetDefinitions.ts imports { app } from
// 'electron' purely for app.getPath('userData'); mocked here to a scratch
// temp directory so the module can be exercised outside a real Electron
// process, following the same pattern as batchRegistryRecovery.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PREPROCESSING_PRESETS } from '../apps/desktop/src/constants/preprocessingPresets.js'

let scratchDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => scratchDir,
  },
}))

describe('preprocessingPresetDefinitions (11.5B follow-up)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-preset-definitions-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('hydrates to factory defaults at version 1 when nothing has been saved yet', async () => {
    const { hydratePresetDefinitions, getPresetDefinitions } = await import(
      '../apps/desktop/electron/services/preprocessingPresetDefinitions.js'
    )
    await hydratePresetDefinitions()
    const defs = getPresetDefinitions()

    for (const preset of ['fast', 'balanced', 'quality'] as const) {
      expect(defs[preset].version).toBe(1)
      const { version, ...values } = defs[preset]
      expect(values).toEqual(DEFAULT_PREPROCESSING_PRESETS[preset]);
    }
  })

  it('increments only the saved preset\'s version and updates its values', async () => {
    const { hydratePresetDefinitions, getPresetDefinitions, savePresetDefinition } = await import(
      '../apps/desktop/electron/services/preprocessingPresetDefinitions.js'
    )
    await hydratePresetDefinitions()

    const editedBalanced = { ...DEFAULT_PREPROCESSING_PRESETS.balanced, edgeStrength: 2.0 }
    const updated = await savePresetDefinition('balanced', editedBalanced)

    expect(updated.version).toBe(2)
    expect(updated.edgeStrength).toBe(2.0)

    const defs = getPresetDefinitions()
    expect(defs.balanced.version).toBe(2)
    expect(defs.balanced.edgeStrength).toBe(2.0)
    // Fast and Quality are untouched by Balanced's save.
    expect(defs.fast.version).toBe(1)
    expect(defs.quality.version).toBe(1)
  })

  it('persists saves to disk and reloads them on the next hydration (simulated app restart)', async () => {
    const first = await import('../apps/desktop/electron/services/preprocessingPresetDefinitions.js')
    await first.hydratePresetDefinitions()
    await first.savePresetDefinition('quality', { ...DEFAULT_PREPROCESSING_PRESETS.quality, maskContrast: 1.4 })

    vi.resetModules()
    const second = await import('../apps/desktop/electron/services/preprocessingPresetDefinitions.js')
    await second.hydratePresetDefinitions()
    const defs = second.getPresetDefinitions()

    expect(defs.quality.version).toBe(2)
    expect(defs.quality.maskContrast).toBe(1.4)
    // Untouched presets still round-trip correctly through disk.
    expect(defs.fast.version).toBe(1)

    const onDisk = JSON.parse(await readFile(join(scratchDir, 'preprocessing-preset-definitions.json'), 'utf-8'))
    expect(onDisk.quality.maskContrast).toBe(1.4)
  })

  it('treats "Reset to default" as a save — same values, incremented version', async () => {
    const { hydratePresetDefinitions, savePresetDefinition } = await import(
      '../apps/desktop/electron/services/preprocessingPresetDefinitions.js'
    )
    await hydratePresetDefinitions()

    await savePresetDefinition('fast', { ...DEFAULT_PREPROCESSING_PRESETS.fast, maskBlur: 5 })
    const reset = await savePresetDefinition('fast', DEFAULT_PREPROCESSING_PRESETS.fast)

    expect(reset.version).toBe(3)
    const { version, ...values } = reset
    expect(values).toEqual(DEFAULT_PREPROCESSING_PRESETS.fast)
  })
})
