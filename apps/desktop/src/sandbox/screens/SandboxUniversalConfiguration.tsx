import { PackageX } from 'lucide-react'
import { ConsoleLayout } from '../../components/console/ConsoleLayout'
import { ConsoleSummaryPanel, type ConsoleSummaryItem } from '../../components/console/ConsoleSummaryPanel'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { useToast } from '../../components/ui/ToastHost'
import { useSandboxWorkflow } from '../context/SandboxWorkflowContext'
import { sortSandboxProductTypes } from '../constants/productDisplay'
import { validateSandboxUniversalConfig } from '../types/sandboxUniversalConfig'
import type { SandboxProductType } from '../types/sandboxProduct'
import { PreprocessingConfigSection } from '../components/PreprocessingConfigSection'
import { EditingConfigSection } from '../components/EditingConfigSection'
import { PostProcessingConfigSection } from '../components/PostProcessingConfigSection'
import { StageArrow } from '../components/StageArrow'
import styles from './SandboxUniversalConfiguration.module.css'

interface SandboxUniversalConfigurationProps {
  onBack: () => void
}

// Sandbox's configuration screen (Phase 15.2) — Preprocessing -> Editing ->
// Post Processing, one Universal Configuration covering every product type
// present in the selected Temporary Batch. Configuration only: "Review
// Configuration" never starts processing (that's 15.3's execution
// orchestrator, not built yet) — it only validates and acknowledges.
export default function SandboxUniversalConfiguration({ onBack }: SandboxUniversalConfigurationProps) {
  const { selectedBatch, config, updateConfig } = useSandboxWorkflow()
  const { showToast } = useToast()

  if (!selectedBatch || !config) {
    return (
      <div className={styles.emptyWrap}>
        <EmptyState
          icon={PackageX}
          message="No Temporary Batch selected."
          actionLabel="Go to Dashboard"
          onAction={onBack}
        />
      </div>
    )
  }

  const productTypes = sortSandboxProductTypes(selectedBatch.productTypes)
  const validation = validateSandboxUniversalConfig(config, selectedBatch)

  function handleToggleScript(productType: SandboxProductType, scriptId: string, enabled: boolean) {
    updateConfig(prev => ({
      ...prev,
      postProcessingByProduct: {
        ...prev.postProcessingByProduct,
        [productType]: { ...prev.postProcessingByProduct[productType], [scriptId]: enabled },
      },
    }))
  }

  function handleReviewConfiguration() {
    if (!validation.ok) return
    showToast({
      title: 'Configuration ready',
      description: 'Automatic execution is not available yet — this configuration is saved for when Phase 15.3 adds it.',
    })
  }

  const summaryItems: ConsoleSummaryItem[] = [
    { label: 'Batch', value: selectedBatch.name },
    { label: 'Images', value: String(selectedBatch.imageCount) },
    { label: 'Product Types', value: String(productTypes.length) },
  ]

  return (
    <ConsoleLayout
      title="Universal Configuration"
      subtitle={`Configuring ${selectedBatch.name} — nothing executes until a later phase.`}
      headerExtra={
        <div className={styles.backRow}>
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← Back to Dashboard
          </Button>
        </div>
      }
      summary={
        <ConsoleSummaryPanel
          items={summaryItems}
          onStart={handleReviewConfiguration}
          startLabel="Review Configuration"
          canStart={validation.ok}
          error={validation.errors[0] ?? null}
        />
      }
    >
      <PreprocessingConfigSection
        config={config.preprocessing}
        onChange={preprocessing => updateConfig(prev => ({ ...prev, preprocessing }))}
      />
      <StageArrow />
      <EditingConfigSection productTypes={productTypes} editingByProduct={config.editingByProduct} />
      <StageArrow />
      <PostProcessingConfigSection
        productTypes={productTypes}
        selectionByProduct={config.postProcessingByProduct}
        editingByProduct={config.editingByProduct}
        onToggleScript={handleToggleScript}
      />
    </ConsoleLayout>
  )
}
