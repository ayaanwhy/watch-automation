// Real resizeGems adapter (automation-engine hardening pass) — Gemstone
// compulsory step 1. See postProcessing/resizeGems/runner.py (a headless
// wrapper; post-scripts/resizeGems.py is untouched).
//
// Artifact flow: reads each SKU's `SKU;compare.png` (the trimmed Gemstone
// editing artifact), copies it UNCHANGED into its output, and writes the
// resized duplicate as `SKU;frontImage.png`. Both must exist afterwards; the
// compare copy must be byte-identical to its input; the frontImage must be a
// valid image that genuinely differs from the compare.
//
// Consumes Sandbox's normalized Gemstone data (width/height/Shape — Shape has
// no source in any Legacy metadata, so it is an explicit required input and
// is validated per item BEFORE this ever runs; nothing here defaults it).
// Batch/directory-level: one subprocess call for the whole product. The
// exit code is never trusted alone — every expected `SKU.png` must exist and
// be a decodable image on the Node side too.
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { engineTempDir } from '../engine/runtime'
import { guarded, outputInvalid, outputMissing, postProcessingScriptPath, runPostProcessingScript, scriptFailure } from './scriptSubprocess'
import { capabilityUnavailable } from './scriptSubprocess'
import type { SandboxPostProcessingAdapter } from './contracts'

export const resizeGemsAdapter: SandboxPostProcessingAdapter = {
  scriptId: 'resizeGems',
  concurrency: 'batch-global',
  run: context =>
    guarded('resizeGems', async () => {
      const gems = (context.items ?? []).filter(i => i.measurement.kind === 'gemstone')
      const rows: Record<string, { widthMm: number; heightMm: number; shape: string }> = {}
      for (const item of gems) {
        const m = item.measurement
        if (m.kind !== 'gemstone' || m.widthMm === null || m.heightMm === null || m.shape === null) continue
        rows[item.sku] = { widthMm: m.widthMm, heightMm: m.heightMm, shape: m.shape }
      }
      if (Object.keys(rows).length === 0) {
        return capabilityUnavailable('resizeGems', 'POSTPROCESSING_CAPABILITY_UNAVAILABLE', 'No Gemstone item has the required width, height and Shape.')
      }

      const sidecarDir = join(engineTempDir(), 'wpa-sandbox-resizegems')
      await mkdir(sidecarDir, { recursive: true })
      const itemsFile = join(sidecarDir, `${randomUUID()}.json`)
      await writeFile(itemsFile, JSON.stringify(rows), 'utf-8')

      const result = await runPostProcessingScript(postProcessingScriptPath('resizeGems'), [
        '--input-dir', context.inputDir,
        '--output-dir', context.outputDir,
        '--items-file', itemsFile,
      ])
      if (!result.ok) return scriptFailure('resizeGems', result)

      // Verify every expected artifact independently of the script's own claim.
      const processed = new Set(((result.resultJson?.['processed'] as { sku: string }[]) ?? []).map(p => p.sku))
      for (const sku of processed) {
        const compareIn = join(context.inputDir, `${sku};compare.png`)
        const compareOut = join(context.outputDir, `${sku};compare.png`)
        const front = join(context.outputDir, `${sku};frontImage.png`)
        for (const path of [compareOut, front]) {
          try {
            await stat(path)
          } catch {
            return outputMissing('resizeGems', `Expected ${path.split('/').pop()} was not created.`)
          }
        }
        // The compare is the reference artifact: its copy must be identical to its input.
        const [inBytes, outBytes, frontBytes] = await Promise.all([readFile(compareIn), readFile(compareOut), readFile(front)])
        if (!inBytes.equals(outBytes)) return outputInvalid('resizeGems', `${sku};compare.png was altered.`)
        if (frontBytes.equals(inBytes)) return outputInvalid('resizeGems', `${sku};frontImage.png is identical to the compare — no processing was applied.`)
        try {
          const meta = await sharp(frontBytes).metadata()
          if (!meta.width || !meta.height) return outputInvalid('resizeGems', `${sku};frontImage.png has no readable dimensions.`)
        } catch (err) {
          return outputInvalid('resizeGems', `${sku};frontImage.png is not a valid image: ${String(err)}`)
        }
      }
      if (processed.size === 0) return outputMissing('resizeGems', 'The script processed no images.')

      return { ok: true, outputDir: context.outputDir, artifact: { kind: 'images', dir: context.outputDir } }
    }),
}
