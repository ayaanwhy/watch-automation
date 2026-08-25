import { join } from 'node:path'
import { processWatch } from '@wpa/processing'
import type { ShadowSettings } from '@wpa/processing'
import { logger } from '../logger'
import { getShadowProfileDefinition } from '../services/shadowProfileDefinitions'
import type { ProcessWatchPayload, ProcessWatchResult } from '../../src/types/ipc'

// packages/processing's shadowEngine.ts (Watch's own shadow implementation
// — a separate TS port of the same algorithm preprocessing/shadow.py uses
// for Ring & Bracelet/Earring, not shared code) takes camelCase field names
// and has no equivalent of horizontal_falloff/canvas_base — see
// constants/shadowProfiles.ts's module comment on the 'watch' profile.
function watchShadowSettings(): Partial<ShadowSettings> {
  const { x_offset, y_offset, blur_radius, spread, density, opacity, color } = getShadowProfileDefinition('watch')
  return { xOffset: x_offset, yOffset: y_offset, blurRadius: blur_radius, spread, density, opacity, color }
}

function classifyError(err: unknown): string {
  const msg = String(err)
  if (msg.includes('ENOENT')) return 'Watch image file not found'
  if (msg.includes('EACCES') || msg.includes('EPERM')) return 'Permission denied reading watch image'
  if (msg.includes('must be a PNG') || msg.includes('Input image')) return 'File is not a valid PNG image'
  if (msg.includes('readable dimensions')) return 'PNG image has no readable dimensions'
  return msg
}

export async function runProcessWatch(payload: ProcessWatchPayload): Promise<ProcessWatchResult> {
  const { spliceBoundaries, scaleBoundaries, sku, inputFolder, outputFolder, widthMm } = payload

  if (spliceBoundaries.leftBoundary >= spliceBoundaries.rightBoundary) {
    return { ok: false, sku, error: 'Splice left boundary must be less than right boundary' }
  }

  if (widthMm <= 0) {
    return { ok: false, sku, error: 'Width measurement must be greater than 0 mm' }
  }

  const inputPath = join(inputFolder, `${sku}.png`)
  const outputPath = join(outputFolder, `${sku};frontImage.png`)
  const startedAt = Date.now()

  logger.info(`Processing ${sku} — width ${widthMm}mm`)

  try {
    const result = await processWatch({
      inputPath,
      outputPath,
      widthMm,
      leftBoundary: spliceBoundaries.leftBoundary,
      rightBoundary: spliceBoundaries.rightBoundary,
      scaleLeft: scaleBoundaries?.leftBoundary,
      scaleRight: scaleBoundaries?.rightBoundary,
      shadow: watchShadowSettings(),
    })
    const ms = Date.now() - startedAt
    logger.info(`Processed ${sku} in ${ms}ms → ${result.outputPath}`)
    return { ok: true, sku, outputPath: result.outputPath }
  } catch (err) {
    const ms = Date.now() - startedAt
    const message = classifyError(err)
    logger.error(`Failed ${sku} after ${ms}ms — ${message}`)
    return { ok: false, sku, error: message }
  }
}
