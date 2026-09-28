import { PackageX } from 'lucide-react'
import { ConsoleLayout } from '../../components/console/ConsoleLayout'
import { ConsoleSummaryPanel, type ConsoleSummaryItem } from '../../components/console/ConsoleSummaryPanel'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { useSandboxWorkflow } from '../context/SandboxWorkflowContext'
import { sortSandboxProductTypes } from '../constants/productDisplay'
import { validateSandboxUniversalConfig } from '../types/sandboxUniversalConfig'
import { normalizeSandboxTemporaryBatch, summarizeSandboxProductValidation } from '../lib/normalizeSandboxProductData'
import type { SandboxProductType } from '../types/sandboxProduct'
import { PreprocessingConfigSection } from '../components/PreprocessingConfigSection'
import { EditingConfigSection } from '../components/EditingConfigSection'
import { PostProcessingConfigSection } from '../components/PostProcessingConfigSection'
import { StageArrow } from '../components/StageArrow'
import { SandboxRunPanel } from '../components/SandboxRunPanel'
import styles from './SandboxUniversalConfiguration.module.css'

interface SandboxUniversalConfigurationProps {
  onBack: () => void
  onReview: () => void
}

// Sandbox's configuration screen (Phase 15.2, wired to real execution in
// Phase 15.3) — Preprocessing -> Editing -> Post Processing, one Universal
// Configuration covering every product type present in the selected
// Temporary Batch. "Start Processing" now really does validate, preflight,
// create the SandboxRun, and begin execution (electron/sandbox/
// sandboxOrchestrator.ts) — only that one explicit action does; navigating
// here never does. Once a run is active for this batch, the editable form
// is replaced by SandboxRunPanel's unified progress view — editing a
// configuration that's already executing wouldn't mean anything.
export default function SandboxUniversalConfiguration({ onBack, onReview }: SandboxUniversalConfigurationProps) {
  const { selectedBatch, config, updateConfig, activeRun, startRunError, starting, startRun, cancelRun, clearActiveRun, retryImage } = useSandboxWorkflow()

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
  const runForThisBatch = activeRun && activeRun.temporaryBatchId === selectedBatch.id ? activeRun : null

  // Phase 15.5 — the one small inline status this phase adds: per-product
  // data-readiness, computed from the same normalization boundary the
  // orchestrator itself consumes (never re-derived ad hoc here).
  const normalizedBatch = normalizeSandboxTemporaryBatch(selectedBatch)
  const validationSummaries = summarizeSandboxProductValidation(normalizedBatch.items)

  function handleToggleScript(productType: SandboxProductType, scriptId: string, enabled: boolean) {
    updateConfig(prev => ({
      ...prev,
      postProcessingByProduct: {
        ...prev.postProcessingByProduct,
        [productType]: { ...prev.postProcessingByProduct[productType], [scriptId]: enabled },
      },
    }))
  }

  if (runForThisBatch) {
    return (
      <ConsoleLayout
        title="Universal Configuration"
        subtitle={`${selectedBatch.name} is executing.`}
        headerExtra={
          <div className={styles.backRow}>
            <Button variant="ghost" size="sm" onClick={onBack}>
              ← Back to Dashboard
            </Button>
          </div>
        }
        summary={<div />}
      >
        <SandboxRunPanel
          run={runForThisBatch}
          onCancel={cancelRun}
          onReview={onReview}
          onRetryImage={retryImage}
          // A fresh run with the same batch + configuration; the previous
          // run stays in the registry untouched.
          onRetry={() => {
            clearActiveRun()
            void startRun()
          }}
        />
      </ConsoleLayout>
    )
  }

  const summaryItems: ConsoleSummaryItem[] = [
    { label: 'Batch', value: selectedBatch.name },
    { label: 'Images', value: String(selectedBatch.imageCount) },
    { label: 'Product Types', value: String(productTypes.length) },
  ]

  return (
    <ConsoleLayout
      title="Universal Configuration"
      subtitle={`Configuring ${selectedBatch.name}.`}
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
          onStart={startRun}
          startLabel="Start Processing"
          canStart={validation.ok}
          starting={starting}
          error={startRunError ?? validation.errors[0] ?? null}
        />
      }
    >
      <PreprocessingConfigSection
        config={config.preprocessing}
        onChange={preprocessing => updateConfig(prev => ({ ...prev, preprocessing }))}
      />
      <StageArrow />
      <EditingConfigSection
        productTypes={productTypes}
        editingByProduct={config.editingByProduct}
        validationSummaries={validationSummaries}
      />
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
