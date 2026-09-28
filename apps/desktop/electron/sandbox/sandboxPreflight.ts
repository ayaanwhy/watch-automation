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
import { engineDataDir } from './engine/runtime'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadBoundaryEndpoint } from '../services/boundaryEndpointPrefs'
import { resolvePostProcessingPython, resolvePreprocessingPython } from '../services/pythonResolver'
import { sandboxApiClient } from './sandboxApiClient'
import { SANDBOX_PRODUCT_AVAILABILITY } from '../../src/sandbox/types/sandboxProduct'
import { validateSandboxUniversalConfig } from '../../src/sandbox/types/sandboxUniversalConfig'
import type { SandboxPreflightCheckResult, SandboxPreflightReport, SandboxPreflightStatus } from '../../src/sandbox/types/sandboxPreflight'
import type { SandboxTemporaryBatchDetail } from '../../src/sandbox/types/sandboxTemporaryBatch'
import type { SandboxUniversalConfig } from '../../src/sandbox/types/sandboxUniversalConfig'

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
  const dir = join(engineDataDir(), 'sandbox-runs')
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

// Final hardening phase — real post-processing (imageResizeNew,
// compressorNew, makeCompareRB, autoMCFF, removeShadows,
// autoMeasurementCalculator) needs a Python interpreter with Pillow (see
// scriptSubprocess.ts/pythonResolver.ts). Every configured product runs
// compressorNew compulsorily, so this is relevant to any run with at least
// one available product — checked here so a missing interpreter is caught
// before preprocessing/editing run at all, not silently discovered only
// after a full (possibly slow) pipeline reaches its very last stage.
// Narrowly scoped to the one baseline every real script shares (Pillow);
// per-script extras (pandas/openpyxl for autoMeasurementCalculator) are
// checked by that adapter itself at run time (Phase 15.7 section 4 —
// capability is per-script, not one global gate this check should
// over-claim).
const postProcessingCapabilityCheck = makeCheck(
  'postProcessingCapability',
  'Post-processing runtime available (Python + Pillow)',
  async (id, label) => {
    const python = await resolvePostProcessingPython()
    return python
      ? result(id, label, 'ok', `Resolved interpreter: ${python}`)
      : result(id, label, 'fail', 'No Python interpreter with Pillow was found — real post-processing scripts cannot run.')
  },
)

// Real preprocessing (Upscaling / Background Removal) runs the UBG Python
// runner, which needs the heavier interpreter (torch/sam2/basicsr) —
// resolved by the same mechanism the runner itself uses. Only relevant when
// the configured operation actually includes a Python step ('none' copies
// files and needs no interpreter).
const preprocessingRuntimeCheck = makeCheck(
  'preprocessingRuntime',
  'Preprocessing runtime available (Python + torch/sam2/basicsr)',
  async (id, label) => {
    const python = await resolvePreprocessingPython()
    return python
      ? result(id, label, 'ok', `Resolved interpreter: ${python}`)
      : result(id, label, 'fail', 'No Python interpreter with the preprocessing dependencies (torch, sam2, basicsr) was found.')
  },
)

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

// Run-specific preflight (Phase 15.3) — checks only the capabilities this
// particular SandboxRun actually needs, per the explicit requirement: the
// Watch connectivity check only runs when the selected batch actually
// contains Watch items, and a product-availability line is added per
// present product type straight from the static SANDBOX_PRODUCT_AVAILABILITY
// map — never a probe, since Necklace/Gemstone have no capability to probe
// in the first place. Distinct from runSandboxPreflight() above (the
// app-level "is Sandbox itself healthy" check, unrelated to any one run).
export async function runSandboxRunPreflight(
  batch: SandboxTemporaryBatchDetail,
  config: SandboxUniversalConfig,
): Promise<SandboxPreflightReport> {
  const checks: SandboxPreflightCheckResult[] = []

  checks.push(await sandboxRunStorageCheck.run())
  checks.push(await sandboxApiClientCheck.run())

  const presentProductTypes = Array.from(new Set(batch.productTypes))
  if (presentProductTypes.includes('watch')) {
    checks.push(await watchEndpointReachableCheck.run())
  }
  if (presentProductTypes.some(p => SANDBOX_PRODUCT_AVAILABILITY[p].available)) {
    checks.push(await postProcessingCapabilityCheck.run())
    if (config.preprocessing.operation !== 'none') checks.push(await preprocessingRuntimeCheck.run())
  }

  const configValidation = validateSandboxUniversalConfig(config, batch)
  checks.push(
    result(
      'configurationValid',
      'Configuration is valid',
      configValidation.ok ? 'ok' : 'fail',
      configValidation.ok ? 'Universal Configuration passed validation.' : configValidation.errors.join(' '),
    ),
  )

  for (const productType of presentProductTypes) {
    const availability = SANDBOX_PRODUCT_AVAILABILITY[productType]
    checks.push(
      result(
        `product:${productType}`,
        `${productType} pipeline`,
        availability.available ? 'ok' : 'skipped',
        availability.available ? 'Pipeline available.' : (availability.reason ?? 'No pipeline available yet.'),
      ),
    )
  }

  return { ranAt: new Date().toISOString(), checks, overall: worstStatus(checks) }
}
