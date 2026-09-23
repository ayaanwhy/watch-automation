import { useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { ConsoleLayout } from '../../components/console/ConsoleLayout'
import { ConsoleSummaryPanel, type ConsoleSummaryItem } from '../../components/console/ConsoleSummaryPanel'
import { Badge } from '../../components/ui/Badge'
import { TemporaryBatchPicker } from '../components/TemporaryBatchPicker'
import { useSandboxTemporaryBatches } from '../hooks/useSandboxTemporaryBatches'
import { useSandboxWorkflow } from '../context/SandboxWorkflowContext'
import { SANDBOX_PRODUCT_GLYPHS, SANDBOX_PRODUCT_LABELS, sortSandboxProductTypes } from '../constants/productDisplay'
import { SANDBOX_PRODUCT_AVAILABILITY } from '../types/sandboxProduct'
import styles from './SandboxDashboard.module.css'

interface SandboxDashboardProps {
  // Navigates to Universal Configuration once a batch has actually been
  // selected and loaded — mirrors Preprocessing.tsx's onStarted prop shape
  // (App.tsx owns the view transition; this screen only decides when it's
  // ready to happen).
  onContinue: () => void
}

// Sandbox's entry screen (Phase 15.2) — Dashboard -> Temporary Batch
// selection -> Start Automation. Reuses the Console archetype (two-pane:
// picker left, summary + primary action right) already established by
// Preprocessing.tsx/EditingSetup.tsx, rather than a bespoke layout. "Start
// Automation" never starts any real processing — it only loads the
// selected batch's full detail and hands off to Universal Configuration
// (see SandboxWorkflowContext.selectBatch).
export default function SandboxDashboard({ onContinue }: SandboxDashboardProps) {
  const { batches, loading, error, refetch } = useSandboxTemporaryBatches()
  const { selectedBatch, selectBatch } = useSandboxWorkflow()
  const [selectedId, setSelectedId] = useState<string | null>(selectedBatch?.id ?? null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const selectedSummary = batches.find(b => b.id === selectedId) ?? null

  async function handleStartAutomation() {
    if (!selectedId) return
    setStarting(true)
    setStartError(null)
    try {
      const detail = await window.api.invoke('sandbox:get-temporary-batch-detail', { id: selectedId })
      if (!detail) {
        setStartError('This Temporary Batch could not be loaded. It may no longer be available.')
        return
      }
      selectBatch(detail)
      onContinue()
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to load this Temporary Batch.')
    } finally {
      setStarting(false)
    }
  }

  const summaryItems: ConsoleSummaryItem[] = selectedSummary
    ? [
        { label: 'Batch', value: selectedSummary.name },
        { label: 'Images', value: String(selectedSummary.imageCount) },
      ]
    : []

  return (
    <ConsoleLayout
      title="Sandbox"
      subtitle="Fully automated processing — select a Temporary Batch to configure and run."
      headerExtra={
        <div className={styles.contextBanner}>
          <FlaskConical size={16} strokeWidth={1.5} aria-hidden="true" />
          <span>
            Sandbox is isolated from your regular batches. Nothing here reads or writes Legacy Input/Output
            folders — batches come from the Sandbox source directly.
          </span>
        </div>
      }
      summary={
        <ConsoleSummaryPanel
          items={summaryItems}
          onStart={handleStartAutomation}
          startLabel="Start Automation"
          canStart={selectedId !== null}
          starting={starting}
          error={startError}
        >
          {selectedSummary && (
            <div className={styles.summaryProducts}>
              {sortSandboxProductTypes(selectedSummary.productTypes).map(productType => {
                const Glyph = SANDBOX_PRODUCT_GLYPHS[productType]
                const available = SANDBOX_PRODUCT_AVAILABILITY[productType].available
                return (
                  <div key={productType} className={styles.summaryProductRow}>
                    <Glyph size={16} strokeWidth={1.5} />
                    <span>{SANDBOX_PRODUCT_LABELS[productType]}</span>
                    <Badge tone={available ? 'neutral' : 'warning'}>{available ? 'Available' : 'Unavailable'}</Badge>
                  </div>
                )
              })}
            </div>
          )}
        </ConsoleSummaryPanel>
      }
    >
      <h2 className={styles.sectionTitle}>Temporary Batches</h2>
      <TemporaryBatchPicker
        batches={batches}
        loading={loading}
        error={error}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onRetry={refetch}
      />
    </ConsoleLayout>
  )
}
