import { useEffect, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { ConsoleLayout } from '../../components/console/ConsoleLayout'
import { ConsoleSummaryPanel, type ConsoleSummaryItem } from '../../components/console/ConsoleSummaryPanel'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { TemporaryBatchPicker } from '../components/TemporaryBatchPicker'
import { useSandboxTemporaryBatches } from '../hooks/useSandboxTemporaryBatches'
import { useSandboxLocalTestBatches } from '../hooks/useSandboxLocalTestBatches'
import { useSandboxWorkflow } from '../context/SandboxWorkflowContext'
import { SANDBOX_PRODUCT_GLYPHS, SANDBOX_PRODUCT_LABELS, sortSandboxProductTypes } from '../constants/productDisplay'
import { SANDBOX_PRODUCT_AVAILABILITY } from '../types/sandboxProduct'
import type { SandboxRunSummary } from '../types/sandboxRun'
import styles from './SandboxDashboard.module.css'

const NON_TERMINAL_RUN_STATUSES = new Set(['draft', 'validating', 'running'])

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
  const { selectedBatch, selectBatch, resumeRun } = useSandboxWorkflow()
  // DEVELOPMENT/TESTING ONLY — existing local Legacy batches as a test source.
  const local = useSandboxLocalTestBatches()
  const [localOpen, setLocalOpen] = useState(selectedBatch?.id.startsWith('local-legacy:') ?? false)
  const [selectedId, setSelectedId] = useState<string | null>(selectedBatch?.id ?? null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [resumableRun, setResumableRun] = useState<SandboxRunSummary | null>(null)
  const [resuming, setResuming] = useState(false)

  // Interrupted/reloaded run recovery (Phase 15.3) — a renderer reload
  // loses in-memory state but never the persisted SandboxRun (see
  // sandboxRunRegistry.ts's atomic writes), so on mount this checks
  // whether one was still in flight and offers to resume watching it,
  // rather than the operator having no way back into it.
  useEffect(() => {
    let cancelled = false
    void window.api.invoke('sandbox:list-runs').then(runs => {
      if (cancelled) return
      setResumableRun(runs.find(r => NON_TERMINAL_RUN_STATUSES.has(r.status)) ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleResume() {
    if (!resumableRun) return
    setResuming(true)
    try {
      const detail = await window.api.invoke('sandbox:get-temporary-batch-detail', { id: resumableRun.temporaryBatchId })
      if (!detail) return
      selectBatch(detail)
      await resumeRun(resumableRun.id)
      onContinue()
    } finally {
      setResuming(false)
    }
  }

  const localBatches = local.result?.batches ?? []
  const selectedSummary = [...batches, ...localBatches].find(b => b.id === selectedId) ?? null

  function toggleLocal() {
    if (!localOpen && !local.result) local.load()
    setLocalOpen(open => !open)
  }

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
        <>
          <div className={styles.contextBanner}>
            <FlaskConical size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>
              Sandbox is isolated from your regular batches. Nothing here reads or writes Legacy Input/Output
              folders — batches come from the Sandbox source directly.
            </span>
          </div>
          {resumableRun && (
            <div className={styles.contextBanner}>
              <span>"{resumableRun.title}" is still in progress.</span>
              <Button size="sm" variant="secondary" onClick={handleResume} loading={resuming}>
                Resume
              </Button>
            </div>
          )}
        </>
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

      <div className={styles.localTestSection}>
        <div className={styles.localTestHeader}>
          <Badge tone="warning">Local test data</Badge>
          <span>
            Development/testing only — use an existing local Legacy batch as the test input. The Legacy batch is only
            read; the run processes its own copy in the Sandbox workspace.
          </span>
          <Button size="sm" variant="secondary" onClick={toggleLocal}>
            {localOpen ? 'Hide' : 'Use Local Batch for Testing'}
          </Button>
        </div>
        {localOpen && (
          <>
            <TemporaryBatchPicker
              batches={localBatches}
              loading={local.loading}
              error={local.error}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRetry={local.load}
              emptyMessage="No usable local Legacy batches were found."
              describe={b => `${b.legacyStatus} · ${new Date(b.createdAt).toLocaleDateString()}`}
            />
            {local.result && local.result.hidden.length > 0 && (
              <details className={styles.localHidden}>
                <summary>{local.result.hidden.length} Legacy batch(es) can't be used as a source</summary>
                <ul>
                  {local.result.hidden.map((h, i) => (
                    <li key={`${h.name}-${i}`}>
                      {h.name} — {h.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </ConsoleLayout>
  )
}
