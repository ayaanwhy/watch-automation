// Phase 15.4 — sandboxPostProcessingRunner: the one authoritative Sandbox
// post-processing entry point. Exercises real orchestration logic
// (canonical order from Phase 15.2's resolveSelectedScripts, sequential
// chaining, cancellation, failure attribution, artifact propagation)
// against controlled fake adapters substituted into the real exported
// registry object — legitimate here because what's under test is this
// file's own dispatch/chaining logic, not any script's real behavior (none
// exist yet — see the Phase 15.4 investigation report). The real
// "everything is unavailable" registry is also exercised directly, for the
// behavior that actually ships today.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSandboxPostProcessingForProduct } from '../apps/desktop/electron/sandbox/sandboxPostProcessing/sandboxPostProcessingRunner'
import { sandboxPostProcessingAdapterRegistry } from '../apps/desktop/electron/sandbox/sandboxPostProcessing/registry'
import type { SandboxPostProcessingAdapter, SandboxPostProcessingScriptContext } from '../apps/desktop/electron/sandbox/sandboxPostProcessing/contracts'

const REAL_APP_PATH = join(__dirname, '..', 'apps', 'desktop')

// sandboxPostProcessingStageDir (sandboxWorkspace.ts) calls
// app.getPath('userData') — vi.mock calls are hoisted above these imports
// by vitest's transform regardless of source order (same pattern as
// boundaryDetectionMapping.test.ts). getAppPath (Phase 15.7) resolves the
// REAL postProcessing/<id>/runner.py scripts in this repository, so the
// "real registry" tests below genuinely exercise the real adapters/scripts,
// not a fake path.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => REAL_APP_PATH },
}))

// Saves/restores the real registry's entries around each test so swapping
// in fakes never leaks between tests or into the real-registry tests below.
const originalAdapters = { ...sandboxPostProcessingAdapterRegistry }

// Phase 15.7's real adapters genuinely spawn a Python subprocess and touch
// the real filesystem — the two tests below run the REAL registry against
// paths that don't exist, so every real adapter fails honestly for a real
// reason (no source directory), never silently. This exercises the same
// "no fabricated success" property Phase 15.4's version of this test
// proved, just against real scripts instead of the (then-universal)
// unavailable adapter.

function setAdapter(scriptId: string, adapter: SandboxPostProcessingAdapter) {
  sandboxPostProcessingAdapterRegistry[scriptId] = adapter
}

function fakeAdapter(
  scriptId: string,
  calls: SandboxPostProcessingScriptContext[],
  impl: (ctx: SandboxPostProcessingScriptContext) => Awaited<ReturnType<SandboxPostProcessingAdapter['run']>>,
): SandboxPostProcessingAdapter {
  return {
    scriptId,
    concurrency: 'safe-concurrent',
    async run(ctx) {
      calls.push(ctx)
      return impl(ctx)
    },
  }
}

describe('runSandboxPostProcessingForProduct — real registry (Phase 15.7 real adapters)', () => {
  it('Ring fails honestly at the first canonical real script when the Editing output directory does not exist — no fabricated success', async () => {
    const result = await runSandboxPostProcessingForProduct({
      runId: 'run-1',
      productType: 'ring',
      batchId: 'batch-1',
      editingOutputDir: '/fake/editing-output',
      selection: {},
    })
    expect(result.ok).toBe(false)
    expect(result.failedScriptId).toBe('imageResizeNew')
    expect(result.error).toContain('imageResizeNew')
    expect(result.completedScriptIds).toEqual([])
  })

  it('Necklace (compressorNew only) also fails honestly against a nonexistent directory, not silently succeeding just because a real script exists', async () => {
    const result = await runSandboxPostProcessingForProduct({
      runId: 'run-1',
      productType: 'necklace',
      batchId: 'batch-1',
      editingOutputDir: '/fake/editing-output',
      selection: {},
    })
    expect(result.ok).toBe(false)
    expect(result.failedScriptId).toBe('compressorNew')
  })

  it('Gemstone fails honestly at resizeGems when it has no normalized Gemstone data to work from (capability unavailable, never fabricated success)', async () => {
    const result = await runSandboxPostProcessingForProduct({
      runId: 'run-1',
      productType: 'gemstone',
      batchId: 'batch-1',
      editingOutputDir: '/fake/editing-output',
      selection: {},
    })
    expect(result.ok).toBe(false)
    expect(result.failedScriptId).toBe('resizeGems')
    expect(result.failure?.code).toBe('POSTPROCESSING_CAPABILITY_UNAVAILABLE')
    expect(result.completedScriptIds).toEqual([])
  })
})

describe('runSandboxPostProcessingForProduct — orchestration logic (fake adapters)', () => {
  afterEach(() => {
    Object.assign(sandboxPostProcessingAdapterRegistry, originalAdapters)
  })

  it('A/D: runs Ring’s canonical scripts in exact order, chaining each script’s output into the next’s input', async () => {
    const calls: SandboxPostProcessingScriptContext[] = []
    for (const id of ['imageResizeNew', 'compressorNew', 'makeCompareRB']) {
      setAdapter(id, fakeAdapter(id, calls, ctx => ({ ok: true, outputDir: `${ctx.inputDir}/${id}-out` })))
    }

    const result = await runSandboxPostProcessingForProduct({
      runId: 'run-1',
      productType: 'ring',
      batchId: 'batch-1',
      editingOutputDir: '/editing-output',
      selection: {}, // autoMCFF stays off — not in the canonical compulsory set
    })

    expect(result.ok).toBe(true)
    expect(calls.map(c => c.scriptId)).toEqual(['imageResizeNew', 'compressorNew', 'makeCompareRB'])
    expect(calls[0].inputDir).toBe('/editing-output')
    expect(calls[1].inputDir).toBe('/editing-output/imageResizeNew-out')
    expect(calls[2].inputDir).toBe('/editing-output/imageResizeNew-out/compressorNew-out')
    expect(result.outputDir).toBe('/editing-output/imageResizeNew-out/compressorNew-out/makeCompareRB-out')
    expect(result.completedScriptIds).toEqual(['imageResizeNew', 'compressorNew', 'makeCompareRB'])
  })

  it('B/I/Q: autoMCFF only runs when explicitly enabled in selection — never called when disabled/omitted', async () => {
    const calls: SandboxPostProcessingScriptContext[] = []
    for (const id of ['imageResizeNew', 'compressorNew', 'makeCompareRB', 'autoMCFF']) {
      setAdapter(id, fakeAdapter(id, calls, ctx => ({ ok: true, outputDir: ctx.inputDir })))
    }

    const disabled = await runSandboxPostProcessingForProduct({
      runId: 'run-1', productType: 'ring', batchId: 'b1', editingOutputDir: '/e', selection: { autoMCFF: false },
    })
    expect(disabled.completedScriptIds).not.toContain('autoMCFF')
    expect(calls.some(c => c.scriptId === 'autoMCFF')).toBe(false)

    calls.length = 0
    const enabled = await runSandboxPostProcessingForProduct({
      runId: 'run-1', productType: 'ring', batchId: 'b1', editingOutputDir: '/e', selection: { autoMCFF: true },
    })
    expect(enabled.completedScriptIds).toContain('autoMCFF')
    expect(calls[calls.length - 1].scriptId).toBe('autoMCFF') // still last — canonical order preserved
  })

  it('F/G/H/L: a mid-chain failure stops the chain, attributes the exact script, and preserves what already completed', async () => {
    const calls: SandboxPostProcessingScriptContext[] = []
    setAdapter('imageResizeNew', fakeAdapter('imageResizeNew', calls, ctx => ({ ok: true, outputDir: ctx.inputDir })))
    setAdapter('compressorNew', fakeAdapter('compressorNew', calls, () => ({ ok: false, error: 'compressorNew exited with code 1: libvips error' })))
    setAdapter('makeCompareRB', fakeAdapter('makeCompareRB', calls, ctx => ({ ok: true, outputDir: ctx.inputDir })))

    const result = await runSandboxPostProcessingForProduct({
      runId: 'run-1', productType: 'ring', batchId: 'b1', editingOutputDir: '/e', selection: {},
    })

    expect(result.ok).toBe(false)
    expect(result.failedScriptId).toBe('compressorNew')
    expect(result.error).toContain('exited with code 1')
    expect(result.completedScriptIds).toEqual(['imageResizeNew'])
    // makeCompareRB never ran — the chain genuinely stopped.
    expect(calls.map(c => c.scriptId)).toEqual(['imageResizeNew', 'compressorNew'])
  })

  it('J: cancellation checked before each script stops the chain without running the next one', async () => {
    const calls: SandboxPostProcessingScriptContext[] = []
    setAdapter('imageResizeNew', fakeAdapter('imageResizeNew', calls, ctx => ({ ok: true, outputDir: ctx.inputDir })))
    setAdapter('compressorNew', fakeAdapter('compressorNew', calls, ctx => ({ ok: true, outputDir: ctx.inputDir })))
    setAdapter('makeCompareRB', fakeAdapter('makeCompareRB', calls, ctx => ({ ok: true, outputDir: ctx.inputDir })))

    let checks = 0
    const result = await runSandboxPostProcessingForProduct({
      runId: 'run-1',
      productType: 'ring',
      batchId: 'b1',
      editingOutputDir: '/e',
      selection: {},
      isCancelled: async () => {
        checks++
        return checks > 1 // cancel right after the first script's check passes
      },
    })

    expect(result.cancelled).toBe(true)
    expect(result.ok).toBe(false)
    expect(calls.map(c => c.scriptId)).toEqual(['imageResizeNew'])
  })

  it('N: a non-image artifact (measurement data) is propagated distinctly, not pretended to be an image', async () => {
    const calls: SandboxPostProcessingScriptContext[] = []
    setAdapter('compressorNew', fakeAdapter('compressorNew', calls, ctx => ({ ok: true, outputDir: ctx.inputDir })))
    setAdapter(
      'autoMeasurementCalculator',
      fakeAdapter('autoMeasurementCalculator', calls, () => ({
        ok: true,
        outputDir: '/e', // measurement scripts may not produce a new image dir at all
        artifact: { kind: 'measurementData', data: { widthMm: 12.4, heightMm: 8.1 } },
      })),
    )

    const result = await runSandboxPostProcessingForProduct({
      runId: 'run-1',
      productType: 'earring',
      batchId: 'b1',
      editingOutputDir: '/e',
      selection: { autoMeasurementCalculator: true },
    })

    expect(result.ok).toBe(true)
    expect(result.artifacts).toEqual([{ kind: 'measurementData', data: { widthMm: 12.4, heightMm: 8.1 } }])
  })

  it('uses a deterministic, script-specific output directory per stage, not an arbitrary/overwritten path', async () => {
    const calls: SandboxPostProcessingScriptContext[] = []
    setAdapter('compressorNew', fakeAdapter('compressorNew', calls, ctx => ({ ok: true, outputDir: ctx.outputDir })))

    await runSandboxPostProcessingForProduct({
      runId: 'run-xyz', productType: 'necklace', batchId: 'b1', editingOutputDir: '/e', selection: {},
    })

    expect(calls[0].outputDir).toContain('run-xyz')
    expect(calls[0].outputDir).toContain('necklace')
    expect(calls[0].outputDir).toContain('compressorNew')
  })
})
