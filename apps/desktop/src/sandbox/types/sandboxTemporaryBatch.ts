// A Temporary Batch (Phase 15.0) is what Sandbox selects from instead of
// Legacy's Input/Output-folder model — sourced from the Sandbox API (see
// electron/sandbox/sandboxApiClient.ts). Target is per SKU-image
// (productType on each image), not a single Target selector for the whole
// batch, per the approved Phase 15 requirements.
import type { SandboxProductType } from './sandboxProduct'

export interface SandboxTemporaryBatchSummary {
  id: string
  name: string
  productTypes: SandboxProductType[]
  imageCount: number
}

export interface SandboxTemporaryBatchImage {
  sku: string
  imagePath: string
  productType: SandboxProductType
}

export interface SandboxTemporaryBatchDetail extends SandboxTemporaryBatchSummary {
  images: SandboxTemporaryBatchImage[]
}
