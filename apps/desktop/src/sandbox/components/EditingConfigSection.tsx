import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { SANDBOX_PRODUCT_GLYPHS, SANDBOX_PRODUCT_LABELS } from '../constants/productDisplay'
import type { SandboxProductType } from '../types/sandboxProduct'
import type { SandboxEditingConfig } from '../types/sandboxUniversalConfig'
import type { SandboxProductValidationSummary } from '../lib/normalizeSandboxProductData'
import styles from './ConfigSection.module.css'

interface EditingConfigSectionProps {
  // Already sorted into canonical display order — see
  // sortSandboxProductTypes in constants/productDisplay.ts.
  productTypes: SandboxProductType[]
  editingByProduct: Partial<Record<SandboxProductType, SandboxEditingConfig>>
  // Phase 15.5 — per-product data-readiness, from the one normalization
  // boundary (normalizeSandboxProductData.ts). Optional so this component
  // still renders sensibly wherever a caller doesn't have a batch to
  // validate against yet.
  validationSummaries?: SandboxProductValidationSummary[]
}

// Sandbox Editing configuration (Phase 15.2) — one card per product type
// present in the selected batch, never silently dropped (per the explicit
// requirement). Every available pipeline (Watch/Ring/Bracelet/Earring) is
// Automatic-only in Sandbox — there is no Manual/Automatic selector and no
// manual annotation checkpoint (Watch reuses Phase 14's automatic boundary
// detection directly). Necklace has no upstream pipeline yet and
// is shown as unavailable rather than pretended-away or invented.
export function EditingConfigSection({ productTypes, editingByProduct, validationSummaries }: EditingConfigSectionProps) {
  return (
    <Card className={styles.card}>
      <h3 className={styles.title}>Editing</h3>
      <div className={styles.productList}>
        {productTypes.map(productType => {
          const Glyph = SANDBOX_PRODUCT_GLYPHS[productType]
          const editing = editingByProduct[productType]
          const available = editing?.available ?? false
          const summary = validationSummaries?.find(s => s.productType === productType)
          return (
            <div key={productType} className={styles.productCard}>
              <div className={styles.productHeader}>
                <Glyph size={20} strokeWidth={1.5} />
                <span className={styles.productName}>{SANDBOX_PRODUCT_LABELS[productType]}</span>
                <Badge tone={available ? 'neutral' : 'warning'}>
                  {available ? (productType === 'gemstone' ? 'Pass-through' : 'Automatic') : 'Unavailable'}
                </Badge>
              </div>
              {available ? (
                <p className={styles.unavailableNote}>
                  {productType === 'watch'
                    ? 'Runs Phase 14’s automatic boundary detection — no manual annotation checkpoint in Sandbox.'
                    : productType === 'gemstone'
                      ? 'Upscaling → Background Removal → Trim, then a pass-through editing boundary (no visual editor). Requires width, height and Shape for every stone.'
                      : 'Runs the existing automatic masking pipeline — no Manual/Automatic selector in Sandbox.'}
                </p>
              ) : (
                <p className={styles.unavailableNote}>
                  {editing?.unavailableReason ?? 'No processing pipeline exists for this product type yet.'}
                </p>
              )}
              {available && summary && summary.invalid > 0 && (
                <p className={styles.unavailableNote}>
                  {summary.invalid} of {summary.total} item{summary.total === 1 ? '' : 's'} missing required data
                  {summary.sampleIssues[0] ? ` — ${summary.sampleIssues[0]}` : ''}
                </p>
              )}
              {available && summary && summary.invalid === 0 && summary.validWithWarnings > 0 && (
                <p className={styles.unavailableNote}>
                  {summary.validWithWarnings} of {summary.total} item{summary.total === 1 ? '' : 's'} usable with missing optional data
                </p>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
