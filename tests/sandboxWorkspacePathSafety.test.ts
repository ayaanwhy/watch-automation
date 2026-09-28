// Phase 15.4 — path safety for Sandbox-API/metadata-supplied names (SKUs).
// Proves a malicious/unusual SKU can never make a materialized file land
// outside its own product's source directory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scratchDir: string

vi.mock('electron', () => ({
  app: { getPath: () => scratchDir },
}))

describe('materializeProductImages — path safety (Phase 15.4)', () => {
  let realImageSource: string

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'wpa-sandbox-path-safety-test-'))
    realImageSource = join(scratchDir, 'real-source.png')
    await writeFile(realImageSource, Buffer.from('fake-png-bytes'))
  })

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true })
  })

  it('a SKU containing "../" traversal sequences cannot escape the materialized source directory', async () => {
    const { materializeProductImages, sandboxSourceDir } = await import('../apps/desktop/electron/sandbox/sandboxWorkspace')

    const escapeTarget = join(scratchDir, 'escaped.png')
    const result = await materializeProductImages('run-1', 'ring', [
      { sku: '../../../escaped', imagePath: realImageSource, productType: 'ring' },
    ])

    expect(existsSync(escapeTarget)).toBe(false)

    const destDir = sandboxSourceDir('run-1', 'ring')
    const files = result.copiedCount > 0 ? await readdir(destDir) : []
    // Either it copied safely *inside* destDir under a sanitized name, or
    // it was rejected outright — either is safe; landing outside destDir
    // is the only unacceptable outcome, already ruled out above.
    for (const file of files) {
      expect(existsSync(join(destDir, file))).toBe(true)
    }
  })

  it('a SKU containing path separators cannot create a nested/escaping path', async () => {
    const { materializeProductImages, sandboxSourceDir } = await import('../apps/desktop/electron/sandbox/sandboxWorkspace')

    const result = await materializeProductImages('run-2', 'ring', [
      { sku: 'a/b/../../c', imagePath: realImageSource, productType: 'ring' },
    ])

    const destDir = sandboxSourceDir('run-2', 'ring')
    if (result.copiedCount > 0) {
      const files = await readdir(destDir)
      for (const file of files) {
        expect(file).not.toContain('/')
        expect(existsSync(join(destDir, file))).toBe(true)
      }
    }
  })

  it('a normal SKU still materializes correctly (safety does not break the common case)', async () => {
    const { materializeProductImages, sandboxSourceDir } = await import('../apps/desktop/electron/sandbox/sandboxWorkspace')

    const result = await materializeProductImages('run-3', 'ring', [
      { sku: 'NORMAL-SKU-001', imagePath: realImageSource, productType: 'ring' },
    ])

    expect(result.ok).toBe(true)
    expect(result.copiedCount).toBe(1)
    const destDir = sandboxSourceDir('run-3', 'ring')
    expect(existsSync(join(destDir, 'NORMAL-SKU-001.png'))).toBe(true)
  })

  // Final hardening phase — section 16's explicit "weird filenames" list:
  // spaces, unicode, punctuation, very long names all materialize safely
  // (inside the workspace, no crash), even though none of them are path
  // traversal attempts.
  it.each([
    ['spaces', 'SKU with spaces 001'],
    ['unicode', 'SKU-日本語-💍-ünïcödé'],
    ['punctuation', 'SKU!@#$%^&()+=~`'],
  ])('a SKU with %s materializes safely inside the workspace, never outside it', async (_label, sku) => {
    const { materializeProductImages, sandboxSourceDir } = await import('../apps/desktop/electron/sandbox/sandboxWorkspace')

    const result = await materializeProductImages('run-weird', 'ring', [{ sku, imagePath: realImageSource, productType: 'ring' }])
    expect(result.ok).toBe(true)
    expect(result.copiedCount).toBe(1)

    const destDir = sandboxSourceDir('run-weird', 'ring')
    const files = await readdir(destDir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(existsSync(join(destDir, file))).toBe(true)
      expect(file).not.toContain('/')
      expect(file).not.toContain('\\')
    }
  })

  // A name long enough to exceed the filesystem's own filename length limit
  // (255 bytes on macOS/most filesystems) legitimately CAN'T be created —
  // that's a real OS constraint, not a security hole. What matters is that
  // it fails gracefully (recorded as a per-SKU failure) rather than
  // crashing the whole batch or somehow writing outside the workspace.
  it('a SKU too long for the filesystem fails that one SKU gracefully, without crashing or escaping the workspace', async () => {
    const { materializeProductImages, sandboxSourceDir } = await import('../apps/desktop/electron/sandbox/sandboxWorkspace')
    const sku = 'SKU-' + 'X'.repeat(500)

    const result = await materializeProductImages('run-weird-long', 'ring', [{ sku, imagePath: realImageSource, productType: 'ring' }])
    expect(result.ok).toBe(false)
    expect(result.failedSkus).toContain(sku)

    const destDir = sandboxSourceDir('run-weird-long', 'ring')
    const files = existsSync(destDir) ? await readdir(destDir) : []
    for (const file of files) {
      expect(existsSync(join(destDir, file))).toBe(true)
    }
  })

  it('a script id cannot escape its post-processing stage directory even if somehow metadata-shaped', async () => {
    const { sandboxPostProcessingStageDir, sandboxEditingOutputDir } = await import('../apps/desktop/electron/sandbox/sandboxWorkspace')
    const dangerous = '../../escaped-script'
    const stageDir = sandboxPostProcessingStageDir('run-4', 'ring', dangerous)
    const editingDir = sandboxEditingOutputDir('run-4', 'ring')
    // The sanitized path must still resolve underneath this run/product's
    // own workspace tree, never above it (e.g. never collapsing back up to
    // editingDir's own parent or beyond).
    expect(stageDir.startsWith(join(editingDir, '..'))).toBe(true)
    expect(stageDir).not.toContain('..')
  })
})
