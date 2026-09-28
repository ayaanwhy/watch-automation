// Shared real-script invocation primitive for Sandbox post-processing
// (Phase 15.7). One small helper, reused by every real adapter, instead of
// a second process-execution abstraction: this spawns via Node's own
// child_process.spawn with an argument array (never a shell string — see
// the Phase 15.7 security requirement), the exact same primitive
// subprocessRunner.ts and pythonResolver.ts's own execFileAsync already
// build on. Post-processing's scripts are one-shot, whole-directory batch
// calls (see the Phase 15.7 investigation — none of the real scripts
// stream per-image NDJSON progress events), so they don't fit
// subprocessRunner.ts's createSubprocessRunner (built for long-running,
// cancelable, per-image-event jobs with a renderer-facing IPC lifecycle);
// reusing that abstraction here would mean forcing a shape onto scripts
// that don't have it, not reuse.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { engineProjectRoot } from '../engine/runtime'
import { join } from 'node:path'
import { mkdir, readdir, copyFile, stat } from 'node:fs/promises'
import { resolvePostProcessingPython } from '../../services/pythonResolver'
import { logger } from '../../logger'
import { classifyThrownError, makeAutomationError, summarizeAutomationError } from '../../../src/sandbox/types/automationError'
import type { AutomationError } from '../../../src/sandbox/types/automationError'
import type { SandboxPostProcessingAdapterResult } from './contracts'

// Monorepo-root-relative, mirroring every existing getRunnerPath()
// convention exactly (preprocessHandlers.ts, ringBraceletHandlers.ts,
// earringHandlers.ts) — never a machine-specific path (Phase 15.7 section
// 18's explicit requirement).
export function postProcessingScriptPath(scriptDirName: string): string {
  return join(engineProjectRoot(), 'postProcessing', scriptDirName, 'runner.py')
}

export type ScriptFailureKind =
  | 'python_unavailable'
  | 'script_missing'
  | 'launch_failed'
  | 'dependency_missing'
  | 'nonzero_exit'
  | 'malformed_result'

export interface RunScriptResult {
  ok: boolean
  failureKind?: ScriptFailureKind
  // e.g. the missing Python module, when failureKind is 'dependency_missing'.
  failureDetail?: string
  stdout: string
  stderr: string
  resultJson: Record<string, unknown> | null
  error?: string
}

// Every real runner.py prints exactly one final line prefixed
// "RESULT_JSON:" (see each script's own doc comment) — this is deliberately
// more robust than relying on stdout being ONLY that one line, since a few
// of these scripts' underlying libraries (PIL, pandas) can still emit
// warnings to stdout in some environments.
function parseResultJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.startsWith('RESULT_JSON:')) {
      try {
        return JSON.parse(line.slice('RESULT_JSON:'.length))
      } catch {
        return null
      }
    }
  }
  return null
}

// Spawns `pythonPath scriptPath ...args`, waits for exit, and parses the
// script's own final RESULT_JSON line. Never trusts the script's own
// exit-code alone OR its own claimed "ok" alone — callers additionally
// verify real output files exist on disk before treating a script as
// having genuinely succeeded (defense in depth against a script that
// exits 0 but didn't actually produce what it claims).
export async function runPostProcessingScript(scriptPath: string, args: string[]): Promise<RunScriptResult> {
  const pythonPath = await resolvePostProcessingPython()
  if (!pythonPath) {
    return {
      ok: false,
      failureKind: 'python_unavailable',
      stdout: '',
      stderr: '',
      resultJson: null,
      error: 'No suitable Python interpreter found for Sandbox post-processing (Pillow is not available in any discovered interpreter).',
    }
  }

  if (!existsSync(scriptPath)) {
    return { ok: false, failureKind: 'script_missing', stdout: '', stderr: '', resultJson: null, error: `Script not found: ${scriptPath}` }
  }

  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(pythonPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    } catch (err) {
      resolve({ ok: false, failureKind: 'launch_failed', stdout: '', stderr: '', resultJson: null, error: `Failed to spawn Python process: ${String(err)}` })
      return
    }

    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', err => {
      resolve({ ok: false, failureKind: 'launch_failed', stdout, stderr, resultJson: null, error: `Failed to run script: ${err.message}` })
    })
    child.on('close', code => {
      const resultJson = parseResultJson(stdout)
      if (code !== 0) {
        logger.error(`sandbox-post-processing — ${scriptPath} exited with code ${code}`, { stderr })
        // A missing Python package surfaces as ModuleNotFoundError — Python's
        // own exception class name, a stable contract (unlike free text).
        const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(stderr)
        resolve({
          ok: false,
          failureKind: missing ? 'dependency_missing' : 'nonzero_exit',
          failureDetail: missing?.[1],
          stdout,
          stderr,
          resultJson,
          error: (resultJson?.['error'] as string) || stderr.trim().slice(-1000) || `Script exited with code ${code}`,
        })
        return
      }
      if (!resultJson || resultJson['ok'] !== true) {
        resolve({
          ok: false,
          failureKind: 'malformed_result',
          stdout,
          stderr,
          resultJson,
          error: (resultJson?.['error'] as string) ?? 'Script exited successfully but did not report a valid result.',
        })
        return
      }
      resolve({ ok: true, stdout, stderr, resultJson })
    })
  })
}

// Copies every regular file directly inside srcDir into destDir (flat,
// non-recursive — every Sandbox post-processing stage directory is flat by
// construction, see sandboxWorkspace.ts). Used by adapters whose real
// script only ADDS to or measures a directory rather than transforming
// every file (makeCompareRB, autoMCFF, autoMeasurementCalculator) so the
// next stage — or Final Review, if this is the last stage — still has a
// real image directory, not just a metadata file.
export async function copyDirFlat(srcDir: string, destDir: string): Promise<number> {
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  let copied = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    await copyFile(join(srcDir, entry.name), join(destDir, entry.name))
    copied++
  }
  return copied
}

export async function dirHasFiles(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.some(e => e.isFile())
  } catch {
    return false
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ---- structured failures ---------------------------------------------------
// Adapters build every failure through these, so the same script failure
// always yields the same AutomationError (code/message/action/retryable).

function toAdapterFailure(failure: AutomationError): SandboxPostProcessingAdapterResult {
  return { ok: false, error: summarizeAutomationError(failure), failure }
}

export function scriptFailure(scriptId: string, result: RunScriptResult): SandboxPostProcessingAdapterResult {
  const technicalMessage = [result.error, result.stderr.trim().slice(-800)].filter(Boolean).join('\n')
  const ctx = { stageDetail: scriptId, technicalMessage, detail: result.failureDetail }
  switch (result.failureKind) {
    case 'python_unavailable':
      return toAdapterFailure(makeAutomationError('POSTPROCESSING_PYTHON_UNAVAILABLE', ctx))
    case 'dependency_missing':
      return toAdapterFailure(makeAutomationError('POSTPROCESSING_DEPENDENCY_MISSING', ctx))
    case 'script_missing':
      return toAdapterFailure(makeAutomationError('POSTPROCESSING_SCRIPT_MISSING', ctx))
    case 'launch_failed':
      return toAdapterFailure(makeAutomationError('POSTPROCESSING_LAUNCH_FAILED', ctx))
    case 'malformed_result':
      return toAdapterFailure(makeAutomationError('POSTPROCESSING_MALFORMED_RESULT', ctx))
    default:
      return toAdapterFailure(makeAutomationError('POSTPROCESSING_NONZERO_EXIT', ctx))
  }
}

export function outputMissing(scriptId: string, what: string): SandboxPostProcessingAdapterResult {
  return toAdapterFailure(makeAutomationError('POSTPROCESSING_OUTPUT_MISSING', { stageDetail: scriptId, technicalMessage: what }))
}

export function outputInvalid(scriptId: string, what: string): SandboxPostProcessingAdapterResult {
  return toAdapterFailure(makeAutomationError('POSTPROCESSING_OUTPUT_INVALID', { stageDetail: scriptId, technicalMessage: what }))
}

export function capabilityUnavailable(scriptId: string, code: 'POSTPROCESSING_PYTHON_UNAVAILABLE' | 'POSTPROCESSING_DEPENDENCY_MISSING' | 'POSTPROCESSING_CAPABILITY_UNAVAILABLE', technical: string, detail?: string): SandboxPostProcessingAdapterResult {
  const failure = makeAutomationError(code, { stageDetail: scriptId, technicalMessage: technical, detail })
  return { ok: false, unavailable: true, error: summarizeAutomationError(failure), failure }
}

// A thrown filesystem/other error inside an adapter (copyDirFlat on a
// vanished directory, an unwritable output dir, ...).
export function thrownFailure(scriptId: string, err: unknown): SandboxPostProcessingAdapterResult {
  const classified = classifyThrownError(err, { stageDetail: scriptId })
  const failure =
    classified.code === 'SOURCE_DISAPPEARED' || classified.code === 'DESTINATION_UNAVAILABLE' || classified.code === 'PERMISSION_DENIED' || classified.code === 'DISK_WRITE_FAILED'
      ? makeAutomationError('POSTPROCESSING_PATH_FAILURE', { stageDetail: scriptId, technicalMessage: classified.technicalMessage, cause: classified.cause })
      : classified
  return toAdapterFailure(failure)
}

// Runs an adapter body; anything it throws becomes an honest structured
// failure instead of an unhandled rejection.
export async function guarded(
  scriptId: string,
  body: () => Promise<SandboxPostProcessingAdapterResult>,
): Promise<SandboxPostProcessingAdapterResult> {
  try {
    return await body()
  } catch (err) {
    return thrownFailure(scriptId, err)
  }
}
