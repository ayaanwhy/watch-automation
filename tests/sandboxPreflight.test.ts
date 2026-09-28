// Final hardening phase — sandboxPreflight.ts had no dedicated test
// coverage before this. Exercises the real checks against a real scratch
// userData dir and the real resolvePostProcessingPython() (this machine's
// actual Python interpreter — same one every other real-execution test in
// this suite already relies on), proving preflight genuinely reflects the
// selected run rather than trusting an interface exists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir: string
const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir, getAppPath: () => REAL_APP_PATH },
}))

function baseBatch(productTypes: string[]) {
  return { id: 'b1', name: 'B', productTypes, imageCount: 0, images: [] }
}

describe('sandboxPreflight — runSandboxRunPreflight', () => {
  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-preflight-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('reports storage writable, Sandbox API responding, and post-processing capability available for a Ring-only batch — no Watch check included', async () => {
    const { runSandboxRunPreflight } = await import('../apps/desktop/electron/sandbox/sandboxPreflight')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const batch = baseBatch(['ring'])
    const config = createInitialUniversalConfig(batch as any)

    const report = await runSandboxRunPreflight(batch as any, config)
    const ids = report.checks.map(c => c.id)
    expect(ids).toContain('sandboxRunStorage')
    expect(ids).toContain('sandboxApiClient')
    expect(ids).toContain('postProcessingCapability')
    expect(ids).not.toContain('watchEndpointReachable')

    const storage = report.checks.find(c => c.id === 'sandboxRunStorage')!
    expect(storage.status).toBe('ok')
    const postProcessing = report.checks.find(c => c.id === 'postProcessingCapability')!
    expect(postProcessing.status).toBe('ok')
    expect(postProcessing.detail).toContain('python')
  })

  it('includes the Watch connectivity check only when Watch is actually present in the batch', async () => {
    const { runSandboxRunPreflight } = await import('../apps/desktop/electron/sandbox/sandboxPreflight')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const batch = baseBatch(['watch', 'ring'])
    const config = createInitialUniversalConfig(batch as any)

    const report = await runSandboxRunPreflight(batch as any, config)
    expect(report.checks.map(c => c.id)).toContain('watchEndpointReachable')
  })

  it('skips the post-processing capability check for a batch whose only product types are entirely unavailable (Necklace)', async () => {
    const { runSandboxRunPreflight } = await import('../apps/desktop/electron/sandbox/sandboxPreflight')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const batch = baseBatch(['necklace'])
    const config = createInitialUniversalConfig(batch as any)

    const report = await runSandboxRunPreflight(batch as any, config)
    // No available product needs post-processing capability to be checked
    // — nothing runnable exists to need it.
    expect(report.checks.map(c => c.id)).not.toContain('postProcessingCapability')
    // Per-product availability lines are still reported honestly.
    expect(report.checks.find(c => c.id === 'product:necklace')?.status).toBe('skipped')
  })

  it('fails the storage check (and the run overall) when the userData path is unwritable', async () => {
    const blockerPath = join(scratchDir, 'blocked-as-a-file')
    await writeFile(blockerPath, 'not a directory')
    scratchDir = blockerPath

    const { runSandboxRunPreflight } = await import('../apps/desktop/electron/sandbox/sandboxPreflight')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const batch = baseBatch(['ring'])
    const config = createInitialUniversalConfig(batch as any)

    const report = await runSandboxRunPreflight(batch as any, config)
    expect(report.checks.find(c => c.id === 'sandboxRunStorage')?.status).toBe('fail')
    expect(report.overall).toBe('fail')
  })

  it('reports the configuration validity check honestly for an invalid config (a batch with no product types)', async () => {
    const { runSandboxRunPreflight } = await import('../apps/desktop/electron/sandbox/sandboxPreflight')
    const { createInitialUniversalConfig } = await import('../apps/desktop/src/sandbox/types/sandboxUniversalConfig')
    const batch = baseBatch([])
    const config = createInitialUniversalConfig(batch as any)

    const report = await runSandboxRunPreflight(batch as any, config)
    const configCheck = report.checks.find(c => c.id === 'configurationValid')!
    expect(configCheck.status).toBe('fail')
    expect(report.overall).toBe('fail')
  })
})
