// Phase 14A — guards against the single highest-severity trap in the Phase
// 14 plan: SESSION_VERSION must never move for the 'ai-adjusted' provenance
// widening (types/session.ts's SessionAnnotation). sessionHandlers.ts's
// session:load hard-discards (returns session: null, not an error) any file
// whose version doesn't match SESSION_VERSION after migrations — a bump
// without a migration would silently drop every operator's resumable
// session. This test exercises the REAL registered ipcMain handlers (not a
// hand-reconstructed copy of the migration logic), so a future version bump
// or migration regression actually fails this test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_VERSION } from '../apps/desktop/src/types/session.js'
import type { SessionFile } from '../apps/desktop/src/types/session.js'
import type { SessionSaveResult, SessionLoadResult } from '../apps/desktop/src/types/ipc.js'

let scratchDir: string
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

function buildSession(): SessionFile {
  return {
    version: SESSION_VERSION,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    inputFolder: '/watch/input',
    outputFolder: '/watch/output',
    spreadsheetPath: '/watch/sheet.xlsx',
    guideMode: 'uniform',
    currentIndex: 2,
    annotations: [
      {
        sku: 'SKU-AI-ACCEPTED',
        status: 'annotated',
        spliceBoundaries: { leftBoundary: 100, rightBoundary: 400, source: 'ai', confidence: 0.91 },
        scaleBoundaries: null,
      },
      {
        sku: 'SKU-AI-ADJUSTED',
        status: 'annotated',
        spliceBoundaries: { leftBoundary: 120, rightBoundary: 420, source: 'ai-adjusted', confidence: 0.62 },
        scaleBoundaries: { leftBoundary: 150, rightBoundary: 390, source: 'ai-adjusted', confidence: 0.62 },
      },
      {
        sku: 'SKU-MANUAL',
        status: 'annotated',
        spliceBoundaries: { leftBoundary: 90, rightBoundary: 410, source: 'manual', confidence: null },
        scaleBoundaries: null,
      },
    ],
    processingQueue: [],
    metadata: {},
  }
}

describe('session v4 round-trip with ai-adjusted provenance (Phase 14A)', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-session-ai-source-test-'))
    handlers.clear()
    vi.resetModules()
    const { registerSessionHandlers } = await import('../apps/desktop/electron/ipc/sessionHandlers.js')
    registerSessionHandlers()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('does not bump SESSION_VERSION for the widened source union', () => {
    // The regression this whole test file exists to prevent: if this ever
    // fails, someone bumped SESSION_VERSION for the 'ai-adjusted' widening
    // — a runtime-invisible string-union change that never needed one.
    expect(SESSION_VERSION).toBe(4)
  })

  it('round-trips a v4 session containing ai and ai-adjusted sources without the load discarding it', async () => {
    const session = buildSession()

    const saveHandler = handlers.get('session:save')
    expect(saveHandler).toBeDefined()
    const saveResult = (await saveHandler!({}, { outputFolder: session.outputFolder, session })) as SessionSaveResult
    expect(saveResult.ok).toBe(true)

    const loadHandler = handlers.get('session:load')
    expect(loadHandler).toBeDefined()
    const loadResult = (await loadHandler!({}, {
      inputFolder: session.inputFolder,
      outputFolder: session.outputFolder,
      spreadsheetPath: session.spreadsheetPath,
    })) as SessionLoadResult

    expect(loadResult.ok).toBe(true)
    // This is the version-discard trap made concrete: session:load returns
    // `session: null` (not an error) for any version mismatch, so a naive
    // "did it error?" check would miss a silently-discarded session.
    expect(loadResult.session).not.toBeNull()
    expect(loadResult.session!.version).toBe(SESSION_VERSION)
    expect(loadResult.session!.annotations).toEqual(session.annotations)
  })

  it('still loads a pre-Phase-14 v4 session using only manual/ai sources (backward compatibility)', async () => {
    const session = buildSession()
    session.annotations = [
      {
        sku: 'SKU-PRE-EXISTING',
        status: 'annotated',
        spliceBoundaries: { leftBoundary: 80, rightBoundary: 420, source: 'manual', confidence: null },
        scaleBoundaries: null,
      },
    ]

    const saveHandler = handlers.get('session:save')!
    await saveHandler({}, { outputFolder: session.outputFolder, session })

    const loadHandler = handlers.get('session:load')!
    const loadResult = (await loadHandler({}, {
      inputFolder: session.inputFolder,
      outputFolder: session.outputFolder,
      spreadsheetPath: session.spreadsheetPath,
    })) as SessionLoadResult

    expect(loadResult.ok).toBe(true)
    expect(loadResult.session).not.toBeNull()
    expect(loadResult.session!.annotations).toEqual(session.annotations)
  })
})
