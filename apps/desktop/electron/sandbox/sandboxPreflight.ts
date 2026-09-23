// Sandbox preflight/readiness gate (Phase 15.0) — a named registry of
// independent checks, capability-oriented so more can be added later (real
// Sandbox API auth, real post-processing script availability, etc.) once
// those contracts exist, without restructuring this file.
//
// Per the approved correction: a generic HTTP success against the Watch
// detection endpoint is NOT treated as proof that every Watch capability is
// healthy — the check below is narrowly labeled as connectivity-only. No
// new external health endpoint is invented; it reuses the exact endpoint
// documented in boundaryDetection.ts's own header comment (the live
// service's /openapi.json, already known to exist from Phase 14's real
// probes).
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadBoundaryEndpoint } from '../services/boundaryEndpointPrefs'
import { sandboxApiClient } from './sandboxApiClient'
import type { SandboxPreflightCheckResult, SandboxPreflightReport, SandboxPreflightStatus } from '../../src/sandbox/types/sandboxPreflight'

const DEFAULT_WATCH_ENDPOINT = 'https://watchdialcoord.clouddeploy.in'
const CHECK_TIMEOUT_MS = 5_000

export interface SandboxPreflightCheck {
  id: string
  label: string
  run: () => Promise<SandboxPreflightCheckResult>
}

// Each check builds its own id/label into the results it returns via this,
// instead of reading them back off `this` — avoids relying on method-call
// `this`-binding for something this simple.
function makeCheck(
  id: string,
  label: string,
  run: (id: string, label: string) => Promise<SandboxPreflightCheckResult>,
): SandboxPreflightCheck {
  return { id, label, run: () => run(id, label) }
}

function result(id: string, label: string, status: SandboxPreflightStatus, detail: string): SandboxPreflightCheckResult {
  return { id, label, status, detail }
}

// Real read/write/delete round-trip against the actual directory
// sandboxRunRegistry.ts uses — not just an access() check, so a
// read-only-mounted or permission-restricted userData dir is caught before
// a real SandboxRun create fails on it.
const sandboxRunStorageCheck = makeCheck('sandboxRunStorage', 'Sandbox run storage is writable', async (id, label) => {
  const dir = join(app.getPath('userData'), 'sandbox-runs')
  const probePath = join(dir, `.preflight-${randomUUID()}.tmp`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(probePath, 'ok', 'utf-8')
    await readFile(probePath, 'utf-8')
    await unlink(probePath)
    return result(id, label, 'ok', `Verified read/write access to ${dir}`)
  } catch (err) {
    return result(id, label, 'fail', `Could not read/write ${dir}: ${String(err)}`)
  }
})

// Connectivity-only — deliberately does not call this "Watch detection is
// healthy." A 2xx/4xx response both prove the service is reachable and
// responding; only a network-level failure (unreachable, timeout, TLS
// error) fails this check.
const watchEndpointReachableCheck = makeCheck(
  'watchEndpointReachable',
  'Watch detection endpoint reachable (connectivity only)',
  async (id, label) => {
    const override = await loadBoundaryEndpoint()
    const endpoint = (override?.trim() || DEFAULT_WATCH_ENDPOINT).replace(/\/+$/, '')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    try {
      const response = await fetch(`${endpoint}/openapi.json`, { signal: controller.signal })
      return result(
        id,
        label,
        'ok',
        `HTTP ${response.status} from ${endpoint}/openapi.json — reachability only, not a capability health check.`,
      )
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return result(id, label, 'fail', aborted ? `Timed out reaching ${endpoint}` : `Could not reach ${endpoint}: ${String(err)}`)
    } finally {
      clearTimeout(timeout)
    }
  },
)

// Checks the actual client object Sandbox will use (currently always the
// mock — see sandboxApiClient.ts) rather than assuming it works, and says
// plainly in its detail that it's the mock, so this is never mistaken for
// a real Sandbox API health check.
const sandboxApiClientCheck = makeCheck('sandboxApiClient', 'Sandbox API client responds', async (id, label) => {
  try {
    const editors = await sandboxApiClient.listEditors()
    const isMock = sandboxApiClient.constructor.name === 'MockSandboxApiClient'
    return result(id, label, 'ok', `${isMock ? '[mock] ' : ''}listEditors() returned ${editors.length} editor(s).`)
  } catch (err) {
    return result(id, label, 'fail', `Sandbox API client call failed: ${String(err)}`)
  }
})

const CHECKS: SandboxPreflightCheck[] = [sandboxRunStorageCheck, watchEndpointReachableCheck, sandboxApiClientCheck]

function worstStatus(checks: SandboxPreflightCheckResult[]): SandboxPreflightStatus {
  if (checks.some(c => c.status === 'fail')) return 'fail'
  if (checks.some(c => c.status === 'warn')) return 'warn'
  if (checks.every(c => c.status === 'skipped')) return 'skipped'
  return 'ok'
}

export async function runSandboxPreflight(): Promise<SandboxPreflightReport> {
  const checks = await Promise.all(CHECKS.map(c => c.run()))
  return { ranAt: new Date().toISOString(), checks, overall: worstStatus(checks) }
}
