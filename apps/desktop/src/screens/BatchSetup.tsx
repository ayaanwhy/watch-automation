import { useState, useEffect, type ReactNode } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import type { BatchValidationResult, BatchLoadResult, MatchSummary, OpenFileOptions } from '../types/ipc'
import type { BatchState } from '../types/annotation'
import type { SessionFile } from '../types/session'
import { PathField } from '../components/PathField'
import { Button } from '../components/ui/Button'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { ConsoleLayout } from '../components/console/ConsoleLayout'
import { ConsoleSummaryPanel, type ConsoleSummaryItem } from '../components/console/ConsoleSummaryPanel'
import { PROCESSING_MODE_OPTIONS } from '../constants/processingMode'
import type { ProcessingMode } from '../constants/processingMode'
import styles from './BatchSetup.module.css'

interface BatchSetupProps {
  onBeginAnnotation(batch: BatchState, initialSession: SessionFile | null, batchName: string): void
  // Seeds the optional batch-name field — set when this screen was entered
  // via Home's "Create & Open" with a custom title; empty for sidebar entry.
  initialBatchName?: string
  handoffFolder?: string | null
  // Console shell (post-Phase-13 rebuild) — EditingSetup builds this once
  // and passes the identical node to Watch/Ring&Bracelet/Earring alike, see
  // EditingSetup.tsx.
  productSelector: ReactNode
}

// Watch's own entry screen — rebuilt onto the Console archetype (Layout
// Philosophy: two-pane, form left, live-restatement summary right owning
// the primary action) to match Ring & Bracelet/Earring's EditingSetup.tsx
// fields, post-Phase-13 review. This is a reskin/recomposition only: every
// state variable, effect, and IPC call below is unchanged from the
// pre-rebuild version — only the returned JSX (and where each piece of
// state renders) changed. Watch's own two real differences from the other
// products' consoles are preserved rather than papered over:
//   - an explicit Validate button (folder/spreadsheet/output are checked
//     together in one batch:validate + batch:load pipeline, not per-field
//     like PathField's own incremental checks), instead of Ring/Bracelet's
//     auto-validate-on-folder-change.
//   - the primary action is Begin Annotation / Resume / Start Fresh, never
//     a job.start()-shaped async action — see ConsoleSummaryPanel's
//     hideStartButton, added specifically for the Resume/Start Fresh case.
// No Mode (Production/Testing) control: Watch's batch-creation path has
// never read it (see EditingSetup.tsx's own doc comment on that prop), and
// showing a toggle that does nothing would be worse than not showing one.
export default function BatchSetup({ onBeginAnnotation, initialBatchName = '', handoffFolder, productSelector }: BatchSetupProps) {
  const [batchName, setBatchName] = useState(initialBatchName)
  const [inputFolder, setInputFolder] = useState('')
  const [spreadsheetPath, setSpreadsheetPath] = useState('')
  const [outputFolder, setOutputFolder] = useState('')
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null)
  const [pathResult, setPathResult] = useState<BatchValidationResult | null>(null)
  const [loadResult, setLoadResult] = useState<BatchLoadResult | null>(null)
  const [existingSession, setExistingSession] = useState<SessionFile | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)
  // Phase 11.5C — defaults to 'manual', the only mode with real behavior
  // today (splice boundaries are always hand-drawn); Automatic exists as
  // the workflow abstraction only until Phase 12 adds AI-driven masking, so
  // it isn't presented as the default choice.
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('manual')

  const canValidate = inputFolder !== '' && spreadsheetPath !== '' && outputFolder !== ''
  const isLoading = loadingMsg !== null

  function clearResults() {
    setPathResult(null)
    setLoadResult(null)
    setExistingSession(null)
    setSessionChecked(false)
  }

  async function pickInputFolder(explicitPath?: string) {
    const path = explicitPath ?? await window.api.invoke('dialog:openFolder', { historyKey: 'watch-input' })
    if (path !== null) {
      setInputFolder(path)
      clearResults()
    }
  }

  async function pickSpreadsheet(explicitPath?: string) {
    const options: OpenFileOptions = {
      historyKey: 'watch-spreadsheet',
      filters: [{ name: 'Spreadsheet', extensions: ['xlsx', 'csv'] }]
    }
    const path = explicitPath ?? await window.api.invoke('dialog:openFile', options)
    if (path !== null) {
      setSpreadsheetPath(path)
      clearResults()
    }
  }

  async function pickOutputFolder(explicitPath?: string) {
    const path = explicitPath ?? await window.api.invoke('dialog:openFolder', { historyKey: 'watch-output' })
    if (path !== null) {
      setOutputFolder(path)
      clearResults()
    }
  }

  // Core validation pipeline — accepts explicit paths so it can be called
  // both from the user-facing button and from the auto-restore effect on mount.
  async function runValidate(f: string, s: string, o: string) {
    if (isLoading) return
    setLoadingMsg('Validating…')

    try {
      const validation = await window.api.invoke('batch:validate', {
        inputFolder: f,
        spreadsheetPath: s,
        outputFolder: o,
      })
      setPathResult(validation)

      if (validation.ok) {
        setLoadingMsg('Analyzing batch…')
        const load = await window.api.invoke('batch:load', { inputFolder: f, spreadsheetPath: s })
        setLoadResult(load)

        if (load.ok) {
          // Persist paths so next launch can restore them.
          void window.api.invoke('prefs:save-last-batch', {
            inputFolder: f,
            spreadsheetPath: s,
            outputFolder: o,
          })

          setLoadingMsg('Checking for saved session…')
          const sessionResult = await window.api.invoke('session:load', {
            inputFolder: f,
            outputFolder: o,
            spreadsheetPath: s,
          })
          setExistingSession(sessionResult.session)
          setSessionChecked(true)
        }
      }
    } finally {
      setLoadingMsg(null)
    }
  }

  async function handleValidate() {
    if (!canValidate || isLoading) return
    clearResults()
    await runValidate(inputFolder, spreadsheetPath, outputFolder)
  }

  // On mount: restore the last-used paths, then auto-validate if all three exist.
  useEffect(() => {
    async function restoreLastBatch() {
      const prefs = await window.api.invoke('prefs:load-last-batch')

      if (prefs.inputFolder)     setInputFolder(prefs.inputFolder)
      if (prefs.spreadsheetPath) setSpreadsheetPath(prefs.spreadsheetPath)
      if (prefs.outputFolder)    setOutputFolder(prefs.outputFolder)

      if (prefs.inputFolder && prefs.spreadsheetPath && prefs.outputFolder) {
        await runValidate(prefs.inputFolder, prefs.spreadsheetPath, prefs.outputFolder)
      }
    }
    restoreLastBatch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function buildBatch(): BatchState {
    return {
      inputFolder,
      outputFolder,
      spreadsheetPath,
      match: loadResult!.match!,
      processingMode,
    }
  }

  const isHandoff = Boolean(handoffFolder && inputFolder === handoffFolder)
  const showActions =
    loadResult?.ok && loadResult.match && loadResult.match.matched.length > 0 && sessionChecked
  const matchedCount = loadResult?.ok && loadResult.match ? loadResult.match.matched.length : null

  const summaryItems: ConsoleSummaryItem[] = [
    { label: 'Matched SKUs', value: matchedCount !== null ? String(matchedCount) : '—' },
    { label: 'Masking', value: processingMode === 'manual' ? 'Manual' : 'Automatic' },
  ]

  return (
    <ConsoleLayout
      title="Editing"
      subtitle="Choose a product, then configure a new batch."
      headerExtra={productSelector}
      summary={
        <ConsoleSummaryPanel
          items={summaryItems}
          startLabel={matchedCount !== null ? `Begin Annotation (${matchedCount} SKUs)` : 'Begin Annotation'}
          onStart={() => onBeginAnnotation(buildBatch(), null, batchName)}
          canStart={Boolean(showActions) && existingSession === null}
          hideStartButton={Boolean(showActions) && existingSession !== null}
        >
          {loadResult !== null && <BatchSummary result={loadResult} />}
          {showActions && existingSession !== null && (
            <ResumePrompt
              session={existingSession}
              total={loadResult!.match!.matched.length}
              onResume={() => onBeginAnnotation(buildBatch(), existingSession, batchName)}
              onFresh={() => onBeginAnnotation(buildBatch(), null, batchName)}
            />
          )}
        </ConsoleSummaryPanel>
      }
    >
      {isHandoff && (
        <p className={styles.handoffMessage}>
          ✓ Input folder prepared from Preprocessing. Choose a spreadsheet and output folder to continue.
        </p>
      )}

      {/* Continuing an existing batch's Watch stage (hand-off from
          Preprocessing) reuses that batch's identity — renaming isn't
          part of this flow, so the field is hidden rather than shown
          inert. It reappears for a genuinely new Watch batch. */}
      {!isHandoff && (
        <div className={styles.nameField}>
          <label className={styles.nameLabel}>Batch Name (optional)</label>
          <input
            className={styles.nameInput}
            type="text"
            value={batchName}
            onChange={e => setBatchName(e.target.value)}
            placeholder="A name is generated if left blank"
            spellCheck={false}
          />
        </div>
      )}
      <PathField
        label="Input Folder"
        value={inputFolder}
        placeholder="Select folder containing watch images"
        onPick={() => pickInputFolder()}
        onDropPath={pickInputFolder}
        badge={isHandoff ? 'Prepared ✓' : undefined}
      />
      <PathField
        label="Spreadsheet"
        value={spreadsheetPath}
        placeholder="Select XLSX or CSV measurement file"
        onPick={() => pickSpreadsheet()}
        onDropPath={pickSpreadsheet}
      />
      <PathField
        label="Output Folder"
        value={outputFolder}
        placeholder="Select folder for processed exports"
        onPick={() => pickOutputFolder()}
        onDropPath={pickOutputFolder}
      />
      <SegmentedControl
        label="Mode"
        options={PROCESSING_MODE_OPTIONS}
        value={processingMode}
        onChange={setProcessingMode}
      />
      {processingMode === 'automatic' && (
        <p className={styles.helperText}>
          AI-driven Watch masking isn't available yet — Automatic currently behaves the same as Manual (splice boundaries are still hand-drawn during annotation).
        </p>
      )}

      <Button variant="primary" onClick={handleValidate} disabled={!canValidate} loading={isLoading}>
        {loadingMsg ?? 'Validate'}
      </Button>

      {pathResult !== null && <ValidationResults result={pathResult} />}
    </ConsoleLayout>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ValidationResults({ result }: { result: BatchValidationResult }) {
  if (result.ok) {
    return (
      <div className={styles.resultsOk}>
        <div className={styles.resultRow}>
          <CheckCircle2 size={14} strokeWidth={2.25} className={styles.ok} aria-hidden="true" />
          <span>
            Input folder found
            {result.imageCount !== undefined &&
              ` — ${result.imageCount} PNG ${result.imageCount === 1 ? 'file' : 'files'}`}
          </span>
        </div>
        <div className={styles.resultRow}>
          <CheckCircle2 size={14} strokeWidth={2.25} className={styles.ok} aria-hidden="true" />
          <span>Spreadsheet found</span>
        </div>
        <div className={styles.resultRow}>
          <CheckCircle2 size={14} strokeWidth={2.25} className={styles.ok} aria-hidden="true" />
          <span>Output folder found</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.resultsError}>
      {result.errors.map((error, index) => (
        <div key={index} className={styles.resultRow}>
          <XCircle size={14} strokeWidth={2.25} className={styles.err} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ))}
    </div>
  )
}

function BatchSummary({ result }: { result: BatchLoadResult }) {
  if (!result.ok) {
    return (
      <div className={styles.summaryError}>
        <div className={styles.summaryTitle}>Batch Analysis Failed</div>
        {result.errors.map((e, i) => (
          <div key={i} className={styles.resultRow}>
            <XCircle size={14} strokeWidth={2.25} className={styles.err} aria-hidden="true" />
            <span>{e}</span>
          </div>
        ))}
      </div>
    )
  }

  const m = result.match as MatchSummary
  const hasWarnings =
    m.missingImages.length > 0 ||
    m.missingSpreadsheetRecords.length > 0 ||
    m.duplicateSpreadsheetSkus.length > 0 ||
    m.duplicateImageSkus.length > 0

  return (
    <div className={hasWarnings ? styles.summaryWarn : styles.summaryOk}>
      <div className={styles.summaryTitle}>Batch Summary</div>

      <div className={styles.statGrid}>
        <StatRow label="Spreadsheet records" value={m.totalSpreadsheetRecords} />
        <StatRow label="PNG files found" value={m.totalImages} />
        <StatRow label="Matched SKUs" value={m.matched.length} accent="ok" />
        {m.missingImages.length > 0 && (
          <StatRow label="Missing images" value={m.missingImages.length} accent="warn" />
        )}
        {m.missingSpreadsheetRecords.length > 0 && (
          <StatRow label="Missing spreadsheet records" value={m.missingSpreadsheetRecords.length} accent="warn" />
        )}
        {m.duplicateSpreadsheetSkus.length > 0 && (
          <StatRow label="Duplicate spreadsheet SKUs" value={m.duplicateSpreadsheetSkus.length} accent="warn" />
        )}
        {m.duplicateImageSkus.length > 0 && (
          <StatRow label="Duplicate image SKUs" value={m.duplicateImageSkus.length} accent="warn" />
        )}
      </div>

      {m.missingImages.length > 0 && (
        <SkuList title="Missing Images" skus={m.missingImages} />
      )}
      {m.missingSpreadsheetRecords.length > 0 && (
        <SkuList title="Missing Spreadsheet Records" skus={m.missingSpreadsheetRecords} />
      )}
      {m.duplicateSpreadsheetSkus.length > 0 && (
        <SkuList title="Duplicate Spreadsheet SKUs" skus={m.duplicateSpreadsheetSkus} />
      )}
      {m.duplicateImageSkus.length > 0 && (
        <SkuList title="Duplicate Image SKUs" skus={m.duplicateImageSkus} />
      )}
    </div>
  )
}

interface ResumePromptProps {
  session: SessionFile
  total: number
  onResume(): void
  onFresh(): void
}

function ResumePrompt({ session, total, onResume, onFresh }: ResumePromptProps) {
  const annotated = session.annotations.filter(a => a.status === 'annotated').length
  return (
    <div className={styles.resumePrompt}>
      <div className={styles.resumeInfo}>
        <span className={styles.resumeLabel}>Saved session found</span>
        <span className={styles.resumeCount}>{annotated} of {total} annotated</span>
      </div>
      <div className={styles.resumeActions}>
        <Button variant="primary" onClick={onResume}>Resume</Button>
        <Button variant="secondary" onClick={onFresh}>Start fresh</Button>
      </div>
    </div>
  )
}

function StatRow({ label, value, accent }: { label: string; value: number; accent?: 'ok' | 'warn' }) {
  return (
    <div className={styles.statRow}>
      <span className={styles.statLabel}>{label}</span>
      <span
        className={[
          styles.statValue,
          accent === 'ok' ? styles.statOk : '',
          accent === 'warn' ? styles.statWarn : ''
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}

function SkuList({ title, skus }: { title: string; skus: string[] }) {
  return (
    <div className={styles.skuList}>
      <div className={styles.skuListTitle}>{title} ({skus.length})</div>
      <div className={styles.skuListBody}>
        {skus.map(sku => (
          <div key={sku} className={styles.skuItem}>{sku}</div>
        ))}
      </div>
    </div>
  )
}
