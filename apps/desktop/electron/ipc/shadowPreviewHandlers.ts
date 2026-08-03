import { ipcMain, app } from 'electron'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../logger'
import { resolvePreprocessingPython } from '../services/pythonResolver'
import type { ShadowPreviewRenderPayload, ShadowPreviewRenderResult } from '../../src/types/ipc'

const execFileAsync = promisify(execFile)

// preprocessing/shadow_preview.py lives at the monorepo's preprocessing/
// root, alongside shadow.py itself (not in a per-product subdirectory like
// RingBracelet/runner.py or Earring/runner.py) — same depth resolution as
// preprocessHandlers.ts's getRunnerPath, one segment shorter.
function getPreviewScriptPath(): string {
  return join(app.getAppPath(), '..', '..', 'preprocessing', 'shadow_preview.py')
}

// One-shot Shadow Profile preview render (Phase 13H) — the debounced
// counterpart to a real batch run: a single synchronous execFile call, no
// NDJSON protocol, no cancellation, no subprocessRunner involvement (that
// infrastructure is built for long-running batches; this needs to return in
// well under a second). Reuses resolvePreprocessingPython() rather than a
// second resolution path, even though shadow_preview.py itself only needs
// numpy+PIL — consistent with every other pipeline's interpreter source.
export function registerShadowPreviewHandlers(): void {
  ipcMain.handle('shadow-preview:render', async (
    _event,
    payload: ShadowPreviewRenderPayload,
  ): Promise<ShadowPreviewRenderResult> => {
    const pythonPath = payload.pythonPath ?? await resolvePreprocessingPython()
    if (!pythonPath) {
      return { ok: false, error: 'No suitable Python interpreter found.' }
    }

    const dir = join(app.getPath('temp'), 'wpa-shadow-preview')
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      logger.error('shadow-preview:render — failed to create temp dir', err)
      return { ok: false, error: 'Failed to prepare preview output location.' }
    }

    const id = randomUUID()
    const settingsPath = join(dir, `${id}.settings.json`)
    const outputPath = join(dir, `${id}.png`)

    try {
      await writeFile(settingsPath, JSON.stringify(payload.values), 'utf-8')
    } catch (err) {
      logger.error('shadow-preview:render — failed to write settings file', err)
      return { ok: false, error: 'Failed to prepare preview settings.' }
    }

    try {
      await execFileAsync(
        pythonPath,
        [getPreviewScriptPath(), '--settings-file', settingsPath, '--output', outputPath],
        { timeout: 30_000 },
      )
    } catch (err) {
      logger.warn('shadow-preview:render — render failed', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    return { ok: true, previewPath: outputPath }
  })
}
