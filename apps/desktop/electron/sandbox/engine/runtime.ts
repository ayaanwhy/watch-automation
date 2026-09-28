// Where the automation engine keeps its data and finds its bundled scripts —
// the one seam between the engine and its host process. The default binds to
// Electron (userData / app path / temp), which is what the desktop app uses;
// a standalone service host calls configureEngineRuntime() once at startup
// with its own directories and the engine needs nothing from Electron for
// these. (Legacy processing primitives the engine reuses — batchRegistry,
// the subprocess runners, the logger — still read Electron's `app`
// directly; see ./README.md "What is still Electron-bound".)
import { app } from 'electron'
import { join } from 'node:path'

export interface EngineRuntime {
  // Root for engine-owned persistent state (sandbox-runs/ lives under it).
  dataDir: () => string
  // Repository root: where postProcessing/, preprocessing/, sampledata/ live.
  projectRoot: () => string
  // Scratch space for short-lived sidecar files.
  tempDir: () => string
}

const electronRuntime: EngineRuntime = {
  dataDir: () => app.getPath('userData'),
  // apps/desktop is the Electron app path in this monorepo; its
  // grandparent is the repo root — the same convention every existing
  // getRunnerPath() uses.
  projectRoot: () => join(app.getAppPath(), '..', '..'),
  tempDir: () => app.getPath('temp'),
}

let active: EngineRuntime = electronRuntime

export function configureEngineRuntime(runtime: Partial<EngineRuntime>): void {
  active = { ...active, ...runtime }
}

export function resetEngineRuntime(): void {
  active = electronRuntime
}

export const engineDataDir = (): string => active.dataDir()
export const engineProjectRoot = (): string => active.projectRoot()
export const engineTempDir = (): string => active.tempDir()
