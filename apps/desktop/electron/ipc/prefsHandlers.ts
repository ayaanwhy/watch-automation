import { ipcMain, app } from 'electron'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../logger'
import { atomicWriteJson } from '../services/atomicFile'
import { getPresetDefinitions, savePresetDefinition } from '../services/preprocessingPresetDefinitions'
import type {
  PreprocessingPreset,
  PreprocessingPresetValues,
  PreprocessingPresetDefinition,
  PreprocessingPresetDefinitions,
} from '../../src/constants/preprocessingPresets'
import type {
  LastBatchPrefs,
  UpscaleFactor,
  ProductType,
  PreprocessingFolderPrefs,
  RingBraceletFolderPrefs,
  RingBraceletFolderPrefsLoadPayload,
  RingBraceletFolderPrefsSavePayload,
  EditingHandoffOptionsPrefs,
  EarringFolderPrefs,
} from '../../src/types/ipc'

const PREFS_FILENAME = 'last-batch.json'
const EDITING_HANDOFF_OPTIONS_FILENAME = 'editing-handoff-options.json'

function prefsFilePath(): string {
  return join(app.getPath('userData'), PREFS_FILENAME)
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

// Phase 11A: every prefs read/write previously failed completely silently
// (bare `catch {}`), so a real error (corrupt JSON, disk full, permissions)
// was indistinguishable from the normal "nothing saved yet" case. ENOENT on
// a read is normal and stays silent; anything else — on a read or a write —
// is now logged so it's visible in diagnostics instead of just vanishing.
function logReadError(label: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
    logger.warn(`prefs — failed to read ${label}`, err)
  }
}
function logWriteError(label: string, err: unknown): void {
  logger.warn(`prefs — failed to write ${label}`, err)
}

export function registerPrefsHandlers(): void {
  ipcMain.handle('prefs:load-last-batch', async (): Promise<LastBatchPrefs> => {
    try {
      const raw = await readFile(prefsFilePath(), 'utf-8')
      const stored = JSON.parse(raw) as Partial<LastBatchPrefs>

      const [inOk, shOk, outOk] = await Promise.all([
        stored.inputFolder    ? exists(stored.inputFolder)    : Promise.resolve(false),
        stored.spreadsheetPath? exists(stored.spreadsheetPath): Promise.resolve(false),
        stored.outputFolder   ? exists(stored.outputFolder)   : Promise.resolve(false),
      ])

      return {
        inputFolder:     inOk  ? stored.inputFolder!     : null,
        spreadsheetPath: shOk  ? stored.spreadsheetPath! : null,
        outputFolder:    outOk ? stored.outputFolder!    : null,
      }
    } catch (err) {
      logReadError('last-batch.json', err)
      return { inputFolder: null, spreadsheetPath: null, outputFolder: null }
    }
  })

  // Phase 11E: every prefs save now goes through atomicWriteJson (temp-then-
  // rename) instead of a direct writeFile — previously a crash mid-write
  // (disk full, power loss) could leave a truncated, unparseable file that
  // would then fail every future load.
  ipcMain.handle('prefs:save-last-batch', async (_event, payload: LastBatchPrefs): Promise<void> => {
    try {
      await atomicWriteJson(prefsFilePath(), payload)
    } catch (err) {
      logWriteError('last-batch.json', err)
    }
  })

  // ── Preprocessing preset selection (Phase 11.5B) ────────────────────────────
  // Only the selected preset *name* is persisted here — what that name
  // currently means is a separate, editable concern (see the preset
  // definitions handlers below).
  ipcMain.handle('prefs:load-preprocessing-preset', async (): Promise<PreprocessingPreset | null> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), 'preprocessing-preset.json'), 'utf-8')
      const v = JSON.parse(raw)
      if (v === 'fast' || v === 'balanced' || v === 'quality') return v as PreprocessingPreset
      return null
    } catch (err) {
      logReadError('preprocessing-preset.json', err)
      return null
    }
  })

  ipcMain.handle('prefs:save-preprocessing-preset', async (_event, payload: PreprocessingPreset): Promise<void> => {
    try {
      await atomicWriteJson(join(app.getPath('userData'), 'preprocessing-preset.json'), payload)
    } catch (err) {
      logWriteError('preprocessing-preset.json', err)
    }
  })

  // ── Preprocessing preset definitions (11.5B follow-up) ──────────────────────
  // What Fast/Balanced/Quality actually mean — editable only from Settings.
  // Always returns the full set (never null): getPresetDefinitions() falls
  // back to factory defaults if nothing has been saved yet, so there's
  // nothing for the renderer to separately default.
  ipcMain.handle('prefs:load-preprocessing-preset-definitions', async (): Promise<PreprocessingPresetDefinitions> => {
    return getPresetDefinitions()
  })

  ipcMain.handle('prefs:save-preprocessing-preset-definition', async (
    _event,
    payload: { preset: PreprocessingPreset; values: PreprocessingPresetValues },
  ): Promise<PreprocessingPresetDefinition> => {
    return savePresetDefinition(payload.preset, payload.values)
  })

  // Remembers the EditingHandoffDialog's last-used Trim/Rotate/Destination
  // choices (Phase 10F) — same one-JSON-value-per-concern pattern as SAM
  // tuning above.
  ipcMain.handle('prefs:load-editing-handoff-options', async (): Promise<EditingHandoffOptionsPrefs | null> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), EDITING_HANDOFF_OPTIONS_FILENAME), 'utf-8')
      return JSON.parse(raw) as EditingHandoffOptionsPrefs
    } catch (err) {
      logReadError(EDITING_HANDOFF_OPTIONS_FILENAME, err)
      return null
    }
  })

  ipcMain.handle('prefs:save-editing-handoff-options', async (_event, payload: EditingHandoffOptionsPrefs): Promise<void> => {
    try {
      await atomicWriteJson(join(app.getPath('userData'), EDITING_HANDOFF_OPTIONS_FILENAME), payload)
    } catch (err) {
      logWriteError(EDITING_HANDOFF_OPTIONS_FILENAME, err)
    }
  })

  // ── Upscale factor pref ─────────────────────────────────────────────────────
  ipcMain.handle('prefs:load-upscale-factor', async (): Promise<UpscaleFactor | null> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), 'upscale-factor.json'), 'utf-8')
      const v = JSON.parse(raw)
      if (v === 1 || v === 2 || v === 4) return v as UpscaleFactor
      return null
    } catch (err) {
      logReadError('upscale-factor.json', err)
      return null
    }
  })

  ipcMain.handle('prefs:save-upscale-factor', async (_event, payload: UpscaleFactor): Promise<void> => {
    try {
      await atomicWriteJson(join(app.getPath('userData'), 'upscale-factor.json'), payload)
    } catch (err) {
      logWriteError('upscale-factor.json', err)
    }
  })

  // ── Product type pref ───────────────────────────────────────────────────────
  ipcMain.handle('prefs:load-product-type', async (): Promise<ProductType | null> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), 'product-type.json'), 'utf-8')
      const v = JSON.parse(raw)
      if (v === 'watch' || v === 'bracelet' || v === 'ring' || v === 'generic') return v as ProductType
      return null
    } catch (err) {
      logReadError('product-type.json', err)
      return null
    }
  })

  ipcMain.handle('prefs:save-product-type', async (_event, payload: ProductType): Promise<void> => {
    try {
      await atomicWriteJson(join(app.getPath('userData'), 'product-type.json'), payload)
    } catch (err) {
      logWriteError('product-type.json', err)
    }
  })

  // ── Preprocessing folder prefs ──────────────────────────────────────────────
  // Validates that saved paths still exist before restoring them, matching the
  // same pattern used by prefs:load-last-batch for Watch Processing folders.
  ipcMain.handle('prefs:load-preprocessing-folders', async (): Promise<PreprocessingFolderPrefs> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), 'preprocessing-folders.json'), 'utf-8')
      const stored = JSON.parse(raw) as Partial<PreprocessingFolderPrefs>
      const [inOk, outOk] = await Promise.all([
        stored.inputDir  ? exists(stored.inputDir)  : Promise.resolve(false),
        stored.outputDir ? exists(stored.outputDir) : Promise.resolve(false),
      ])
      return {
        inputDir:  inOk  ? stored.inputDir!  : null,
        outputDir: outOk ? stored.outputDir! : null,
      }
    } catch (err) {
      logReadError('preprocessing-folders.json', err)
      return { inputDir: null, outputDir: null }
    }
  })

  ipcMain.handle('prefs:save-preprocessing-folders', async (_event, payload: PreprocessingFolderPrefs): Promise<void> => {
    try {
      await atomicWriteJson(join(app.getPath('userData'), 'preprocessing-folders.json'), payload)
    } catch (err) {
      logWriteError('preprocessing-folders.json', err)
    }
  })

  // ── Ring & Bracelet folder prefs (Phase 10D) ────────────────────────────────
  // One file, product-keyed — mirrors the preprocessing-folders pattern but
  // Ring and Bracelet remember separate folders rather than sharing a slot.
  ipcMain.handle('prefs:load-ring-bracelet-folders', async (
    _event,
    payload: RingBraceletFolderPrefsLoadPayload,
  ): Promise<RingBraceletFolderPrefs> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), 'ring-bracelet-folders.json'), 'utf-8')
      const stored = JSON.parse(raw) as Partial<Record<'ring' | 'bracelet', Partial<RingBraceletFolderPrefs>>>
      const entry = stored[payload.product] ?? {}
      const [inOk, outOk] = await Promise.all([
        entry.inputDir  ? exists(entry.inputDir)  : Promise.resolve(false),
        entry.outputDir ? exists(entry.outputDir) : Promise.resolve(false),
      ])
      return {
        inputDir:  inOk  ? entry.inputDir!  : null,
        outputDir: outOk ? entry.outputDir! : null,
      }
    } catch (err) {
      logReadError('ring-bracelet-folders.json', err)
      return { inputDir: null, outputDir: null }
    }
  })

  ipcMain.handle('prefs:save-ring-bracelet-folders', async (
    _event,
    payload: RingBraceletFolderPrefsSavePayload,
  ): Promise<void> => {
    const filePath = join(app.getPath('userData'), 'ring-bracelet-folders.json')
    try {
      let stored: Partial<Record<'ring' | 'bracelet', Partial<RingBraceletFolderPrefs>>> = {}
      try {
        stored = JSON.parse(await readFile(filePath, 'utf-8'))
      } catch (err) {
        logReadError('ring-bracelet-folders.json', err)
      }
      stored[payload.product] = { inputDir: payload.inputDir, outputDir: payload.outputDir }
      await atomicWriteJson(filePath, stored)
    } catch (err) {
      logWriteError('ring-bracelet-folders.json', err)
    }
  })

  // ── Earring folder + metadata sheet prefs (Phase 12C) ───────────────────────
  // One shared slot (unlike Ring/Bracelet's product-keyed file) — there's
  // only one Earring product to remember inputs for. Validates the two
  // folders and the metadata sheet path all still exist before restoring
  // them, same pattern as prefs:load-preprocessing-folders.
  ipcMain.handle('prefs:load-earring-folders', async (): Promise<EarringFolderPrefs> => {
    try {
      const raw = await readFile(join(app.getPath('userData'), 'earring-folders.json'), 'utf-8')
      const stored = JSON.parse(raw) as Partial<EarringFolderPrefs>
      const [inOk, outOk, metaOk] = await Promise.all([
        stored.inputDir ? exists(stored.inputDir) : Promise.resolve(false),
        stored.outputDir ? exists(stored.outputDir) : Promise.resolve(false),
        stored.metadataFilePath ? exists(stored.metadataFilePath) : Promise.resolve(false),
      ])
      return {
        inputDir: inOk ? stored.inputDir! : null,
        outputDir: outOk ? stored.outputDir! : null,
        metadataFilePath: metaOk ? stored.metadataFilePath! : null,
      }
    } catch (err) {
      logReadError('earring-folders.json', err)
      return { inputDir: null, outputDir: null, metadataFilePath: null }
    }
  })

  ipcMain.handle('prefs:save-earring-folders', async (_event, payload: EarringFolderPrefs): Promise<void> => {
    try {
      await atomicWriteJson(join(app.getPath('userData'), 'earring-folders.json'), payload)
    } catch (err) {
      logWriteError('earring-folders.json', err)
    }
  })
}
