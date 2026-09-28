// Sandbox-owned execution workspace (Phase 15.3) — one directory tree per
// SandboxRun, co-located under the same userData/sandbox-runs/ root
// sandboxRunRegistry.ts already owns, never touching Legacy's
// userData/batches/ output conventions or any Legacy-configured
// input/output folder.
import { engineDataDir } from './engine/runtime'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join, basename, resolve, sep } from 'node:path'
import type { SandboxProductType } from '../../src/sandbox/types/sandboxProduct'
import type { SandboxNormalizedProductItem } from '../../src/sandbox/types/sandboxProductData'

function runWorkspaceDir(runId: string): string {
  return join(engineDataDir(), 'sandbox-runs', runId, 'workspace')
}

function productDir(runId: string, productType: SandboxProductType): string {
  return join(runWorkspaceDir(runId), productType)
}

export function sandboxSourceDir(runId: string, productType: SandboxProductType): string {
  return join(productDir(runId, productType), 'source')
}
export function sandboxPreprocessedDir(runId: string, productType: SandboxProductType): string {
  return join(productDir(runId, productType), 'preprocessed')
}
export function sandboxEditingInputDir(runId: string, productType: SandboxProductType): string {
  return join(productDir(runId, productType), 'editing-input')
}
export function sandboxEditingOutputDir(runId: string, productType: SandboxProductType): string {
  return join(productDir(runId, productType), 'editing-output')
}

// One directory per post-processing script for a given product (Phase
// 15.4) — deterministic, script-specific output locations so a failed
// script leaves enough information to tell exactly which stage produced
// which files (see sandboxPostProcessing/sandboxPostProcessingRunner.ts).
// scriptId is always one of the fixed internal script ids (registry.ts),
// never user/metadata-supplied, but sanitized anyway for defense in depth.
export function sandboxPostProcessingStageDir(runId: string, productType: SandboxProductType, scriptId: string): string {
  return join(productDir(runId, productType), 'post-processing', safeSegment(scriptId))
}

export interface MaterializeResult {
  ok: boolean
  copiedCount: number
  failedSkus: string[]
  // Why each failed, as the thrown value (classified by the caller into a
  // structured AutomationError — see classifyThrownError/UnsafePathError).
  failures: { sku: string; cause: unknown }[]
}

// Thrown when a computed path would leave its workspace directory — kept
// distinct so callers can report UNSAFE_PATH rather than a generic failure.
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafePathError'
  }
}

// The orchestrator's first real step per product type: copies just that
// product's source images into their own materialized folder, so a
// product-specific runner (which expects one homogeneous input directory —
// see subprocessRunner.ts's RunnerConfig) never sees another product's
// images, regardless of how the Temporary Batch's own source files happen
// to be organized. Deliberately a plain per-file copy — the exact same
// lightweight-copy technique sandboxNonePreprocessing.ts already
// established (Phase 15.1) — not a new copying mechanism.
export async function materializeProductImages(
  runId: string,
  productType: SandboxProductType,
  items: SandboxNormalizedProductItem[],
): Promise<MaterializeResult> {
  const destDir = sandboxSourceDir(runId, productType)
  await mkdir(destDir, { recursive: true })

  const failedSkus: string[] = []
  const failures: { sku: string; cause: unknown }[] = []
  let copiedCount = 0

  await Promise.all(
    items.map(async item => {
      try {
        if (!item.imagePath) throw Object.assign(new Error('no source image path'), { code: 'ENOENT' })
        await stat(item.imagePath)
        const destName = `${safeSegment(item.sku)}${extname(item.imagePath)}`
        const destPath = join(destDir, destName)
        assertWithinDir(destDir, destPath)
        await copyFile(item.imagePath, destPath)
        copiedCount++
      } catch (cause) {
        failedSkus.push(item.sku)
        failures.push({ sku: item.sku, cause })
      }
    }),
  )

  return { ok: failedSkus.length === 0, copiedCount, failedSkus, failures }
}

function extname(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : '.png'
}

// Strips path-separator and parent-directory-traversal sequences from a
// Sandbox-API/metadata-supplied name segment (a Temporary Batch SKU today;
// any future similar field) before it's used to build a filesystem path —
// this data ultimately comes from batch/SKU metadata, never something
// Sandbox itself generated, and must never be able to make a materialized
// or output path resolve outside its own workspace directory (Phase 15.4
// security requirement).
//
// Exported (Phase 15.7) so the real post-processing adapters reuse this
// exact sanitizer when copying files between per-script workspace
// directories, rather than a second, slightly different implementation.
export function safeSegment(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/\.\./g, '_')
}

// Defense in depth beyond safeSegment: rejects a computed path outright if
// it doesn't actually resolve inside the directory it was meant to be
// under, rather than trusting sanitization alone. Exported (Phase 15.7) for
// the same reason as safeSegment above.
export function assertWithinDir(dir: string, target: string): void {
  const resolvedDir = resolve(dir) + sep
  const resolvedTarget = resolve(target)
  if (!(resolvedTarget + sep).startsWith(resolvedDir) && resolvedTarget !== resolve(dir)) {
    throw new UnsafePathError(`Refusing to write outside the Sandbox workspace: ${target}`)
  }
}
