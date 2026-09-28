// Cheap up-front check of each materialized source image: is it a readable
// image in a format the pipelines accept? Reading only the header (sharp
// metadata) catches corrupt/truncated files and wrong formats BEFORE any
// expensive preprocessing starts, and yields a precise per-image error
// instead of a generic downstream failure.
import { readdir, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import sharp from 'sharp'
import { mapWithConcurrency } from '../../services/workflowPreparation'
import { makeAutomationError, type AutomationError } from '../../../src/sandbox/types/automationError'
import type { SandboxProductType } from '../../../src/sandbox/types/sandboxProduct'

const ACCEPTED_FORMATS = new Set(['png', 'jpeg', 'webp'])
const PROBE_CONCURRENCY = 4

function stem(file: string): string {
  const ext = extname(file)
  return ext ? file.slice(0, -ext.length) : file
}

// Returns the failures; each failed image's workspace copy is removed so no
// downstream stage ever picks it up.
export async function probeSourceImages(
  sourceDir: string,
  productType: SandboxProductType,
  skusByStem: Map<string, string>,
): Promise<{ sku: string; failure: AutomationError }[]> {
  const files = (await readdir(sourceDir).catch(() => [] as string[])).filter(f => !f.startsWith('.'))
  const failures: { sku: string; failure: AutomationError }[] = []

  await mapWithConcurrency(files, PROBE_CONCURRENCY, async file => {
    const sku = skusByStem.get(stem(file).toLowerCase())
    if (!sku) return
    const path = join(sourceDir, file)
    try {
      const meta = await sharp(path).metadata()
      if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
        failures.push({
          sku,
          failure: makeAutomationError('SOURCE_IMAGE_UNSUPPORTED_FORMAT', { productType, sku, technicalMessage: `Detected format: ${meta.format ?? 'unknown'}` }),
        })
        await unlink(path).catch(() => {})
      } else if (!meta.width || !meta.height) {
        failures.push({ sku, failure: makeAutomationError('SOURCE_IMAGE_UNREADABLE', { productType, sku, technicalMessage: 'Image has no readable dimensions.' }) })
        await unlink(path).catch(() => {})
      }
    } catch (err) {
      failures.push({
        sku,
        failure: makeAutomationError('SOURCE_IMAGE_UNREADABLE', { productType, sku, technicalMessage: err instanceof Error ? err.message : String(err) }),
      })
      await unlink(path).catch(() => {})
    }
  })
  return failures
}
