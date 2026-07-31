import { ipcMain } from 'electron'
import { parseProductMetadata, discoverImages, matchProductMetadata } from '@wpa/processing/data'
import { classifyEarringType } from '../../src/constants/earringClassification'
import type { EarringType } from '../../src/constants/earringClassification'
import { logger } from '../logger'
import type { ProductMetadataLoadPayload, ProductMetadataLoadResult } from '../../src/types/ipc'

// Generic product-metadata IPC surface (Phase 12B) — mirrors dataHandlers.ts's
// batch:load exactly (one round trip: parse → discover → match), with one
// addition: Earring classification is layered on top here, in the app-side
// handler, not inside @wpa/processing's generic parse/match functions (see
// constants/earringClassification.ts). Nothing in the renderer calls this
// channel yet — Phase 12C's EditingSetup.tsx earring branch is the first
// consumer; this phase only builds and validates the capability.
export function registerMetadataHandlers(): void {
  ipcMain.handle('product-metadata:load', async (_event, payload: ProductMetadataLoadPayload): Promise<ProductMetadataLoadResult> => {
    let parsed
    try {
      parsed = parseProductMetadata(payload.metadataFilePath)
    } catch (err) {
      logger.error('product-metadata:load — metadata file read failed', err)
      return { ok: false, errors: ['Failed to read product metadata file.'] }
    }

    if (parsed.errors.length > 0) {
      logger.warn(`product-metadata:load — metadata file invalid: ${parsed.errors.join('; ')}`)
      return { ok: false, errors: parsed.errors }
    }

    let images
    try {
      images = discoverImages(payload.inputFolder)
    } catch (err) {
      logger.error('product-metadata:load — image discovery failed', err)
      return { ok: false, errors: ['Failed to scan input folder.'] }
    }

    const match = matchProductMetadata(parsed, images)

    const bySku: Record<string, EarringType> = {}
    const unmapped: string[] = []
    for (const sku of match.matched) {
      const type = classifyEarringType(match.rows[sku].subCategory)
      if (type === null) {
        unmapped.push(sku)
      } else {
        bySku[sku] = type
      }
    }

    logger.info(
      `product-metadata:load — ${match.matched.length} matched, ` +
      `${match.missingImages.length} missing images, ` +
      `${match.missingMetadataRecords.length} missing records, ` +
      `${unmapped.length} unmapped Sub-Category`
    )

    return { ok: true, errors: [], match, classification: { bySku, unmapped } }
  })
}
