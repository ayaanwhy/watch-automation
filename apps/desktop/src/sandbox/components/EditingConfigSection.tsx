import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { SANDBOX_PRODUCT_GLYPHS, SANDBOX_PRODUCT_LABELS } from '../constants/productDisplay'
import type { SandboxProductType } from '../types/sandboxProduct'
import type { SandboxEditingConfig } from '../types/sandboxUniversalConfig'
import styles from './ConfigSection.module.css'

interface EditingConfigSectionProps {
  // Already sorted into canonical display order — see
  // sortSandboxProductTypes in constants/productDisplay.ts.
  productTypes: SandboxProductType[]
  editingByProduct: Partial<Record<SandboxProductType, SandboxEditingConfig>>
}

// Sandbox Editing configuration (Phase 15.2) — one card per product type
// present in the selected batch, never silently dropped (per the explicit
// requirement). Every available pipeline (Watch/Ring/Bracelet/Earring) is
// Automatic-only in Sandbox — there is no Manual/Automatic selector and no
// manual annotation checkpoint (Watch reuses Phase 14's automatic boundary
// detection directly). Necklace/Gemstone have no upstream pipeline yet and
// are shown as unavailable rather than pretended-away or invented.
export function EditingConfigSection({ productTypes, editingByProduct }: EditingConfigSectionProps) {
  return (
    <Card className={styles.card}>
      <h3 className={styles.title}>Editing</h3>
      <div className={styles.productList}>
        {productTypes.map(productType => {
          const Glyph = SANDBOX_PRODUCT_GLYPHS[productType]
          const editing = editingByProduct[productType]
          const available = editing?.available ?? false
          return (
            <div key={productType} className={styles.productCard}>
              <div className={styles.productHeader}>
                <Glyph size={20} strokeWidth={1.5} />
                <span className={styles.productName}>{SANDBOX_PRODUCT_LABELS[productType]}</span>
                <Badge tone={available ? 'neutral' : 'warning'}>{available ? 'Automatic' : 'Unavailable'}</Badge>
              </div>
              {available ? (
                <p className={styles.unavailableNote}>
                  {productType === 'watch'
                    ? 'Runs Phase 14’s automatic boundary detection — no manual annotation checkpoint in Sandbox.'
                    : 'Runs the existing automatic masking pipeline — no Manual/Automatic selector in Sandbox.'}
                </p>
              ) : (
                <p className={styles.unavailableNote}>
                  {editing?.unavailableReason ?? 'No processing pipeline exists for this product type yet.'}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
