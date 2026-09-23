import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { SANDBOX_PRODUCT_GLYPHS, SANDBOX_PRODUCT_LABELS } from '../constants/productDisplay'
import { SANDBOX_POST_PROCESSING_SCRIPTS, type SandboxPostProcessingSelection } from '../types/sandboxPostProcessing'
import type { SandboxProductType } from '../types/sandboxProduct'
import type { SandboxEditingConfig } from '../types/sandboxUniversalConfig'
import styles from './ConfigSection.module.css'

interface PostProcessingConfigSectionProps {
  productTypes: SandboxProductType[]
  selectionByProduct: Partial<Record<SandboxProductType, SandboxPostProcessingSelection>>
  editingByProduct: Partial<Record<SandboxProductType, SandboxEditingConfig>>
  onToggleScript: (productType: SandboxProductType, scriptId: string, enabled: boolean) => void
}

// Sandbox Post Processing configuration (Phase 15.2) — the known canonical
// script list/order per product type (supplied directly by the user, not
// inferred). Compulsory scripts are preselected and cannot be disabled;
// optional scripts are individually toggleable. Order is fixed — no
// drag-and-drop. This is configuration only: nothing here invokes a
// script, and no script arguments are constructed anywhere in this file.
export function PostProcessingConfigSection({
  productTypes,
  selectionByProduct,
  editingByProduct,
  onToggleScript,
}: PostProcessingConfigSectionProps) {
  return (
    <Card className={styles.card}>
      <h3 className={styles.title}>Post Processing</h3>
      <div className={styles.productList}>
        {productTypes.map(productType => {
          const Glyph = SANDBOX_PRODUCT_GLYPHS[productType]
          const scripts = SANDBOX_POST_PROCESSING_SCRIPTS[productType]
          const selection = selectionByProduct[productType] ?? {}
          const editingAvailable = editingByProduct[productType]?.available ?? false
          return (
            <div key={productType} className={styles.productCard}>
              <div className={styles.productHeader}>
                <Glyph size={20} strokeWidth={1.5} />
                <span className={styles.productName}>{SANDBOX_PRODUCT_LABELS[productType]}</span>
              </div>
              {!editingAvailable && (
                <p className={styles.unavailableNote}>
                  Editing has no pipeline for this product yet — this configuration is stored but cannot run.
                </p>
              )}
              <ol className={styles.scriptList}>
                {scripts.map((script, index) => (
                  <li key={script.id} className={styles.scriptRow}>
                    <span className={styles.scriptOrder}>{index + 1}.</span>
                    <span className={styles.scriptLabel}>{script.label}</span>
                    {script.compulsory ? (
                      <Badge tone="neutral">Required</Badge>
                    ) : (
                      <label className={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={selection[script.id] === true}
                          onChange={e => onToggleScript(productType, script.id, e.target.checked)}
                        />
                        Optional
                      </label>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
