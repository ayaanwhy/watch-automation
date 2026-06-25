import { useState, useEffect } from 'react'
import type { BatchValidationResult, BatchLoadResult, MatchSummary, OpenFileOptions } from '../types/ipc'
import type { BatchState } from '../types/annotation'
import type { SessionFile } from '../types/session'
import styles from './BatchSetup.module.css'

interface BatchSetupProps {
  onBeginAnnotation(batch: BatchState, initialSession: SessionFile | null): void
}

export default function BatchSetup({ onBeginAnnotation }: BatchSetupProps) {
  const [inputFolder, setInputFolder] = useState('')
  const [spreadsheetPath, setSpreadsheetPath] = useState('')
  const [outputFolder, setOutputFolder] = useState('')
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null)
  const [pathResult, setPathResult] = useState<BatchValidationResult | null>(null)
  const [loadResult, setLoadResult] = useState<BatchLoadResult | null>(null)
  const [existingSession, setExistingSession] = useState<SessionFile | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)

  const canValidate = inputFolder !== '' && spreadsheetPath !== '' && outputFolder !== ''
  const isLoading = loadingMsg !== null

  function clearResults() {
    setPathResult(null)
    setLoadResult(null)
    setExistingSession(null)
    setSessionChecked(false)
  }

  async function pickInputFolder() {
    const path = await window.api.invoke('dialog:openFolder')
    if (path !== null) {
      setInputFolder(path)
      clearResults()
    }
  }

  async function pickSpreadsheet() {
    const options: OpenFileOptions = {
      filters: [{ name: 'Spreadsheet', extensions: ['xlsx', 'csv'] }]
    }
    const path = await window.api.invoke('dialog:openFile', options)
    if (path !== null) {
      setSpreadsheetPath(path)
      clearResults()
    }
  }

  async function pickOutputFolder() {
    const path = await window.api.invoke('dialog:openFolder')
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
    }
  }

  const showActions =
    loadResult?.ok && loadResult.match && loadResult.match.matched.length > 0 && sessionChecked

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>New Batch</h1>

        <div className={styles.fields}>
          <PathField
            label="Input Folder"
            value={inputFolder}
            placeholder="Select folder containing watch images"
            onPick={pickInputFolder}
          />
          <PathField
            label="Spreadsheet"
            value={spreadsheetPath}
            placeholder="Select XLSX or CSV measurement file"
            onPick={pickSpreadsheet}
          />
          <PathField
            label="Output Folder"
            value={outputFolder}
            placeholder="Select folder for processed exports"
            onPick={pickOutputFolder}
          />
        </div>

        <div className={styles.actions}>
          <button
            className={styles.validateButton}
            onClick={handleValidate}
            disabled={!canValidate || isLoading}
          >
            {loadingMsg ?? 'Validate'}
          </button>
        </div>

        {pathResult !== null && <ValidationResults result={pathResult} />}
        {loadResult !== null && <BatchSummary result={loadResult} />}

        {showActions && (
          existingSession !== null ? (
            <ResumePrompt
              session={existingSession}
              total={loadResult!.match!.matched.length}
              onResume={() => onBeginAnnotation(buildBatch(), existingSession)}
              onFresh={() => onBeginAnnotation(buildBatch(), null)}
            />
          ) : (
            <div className={styles.actions}>
              <button
                className={styles.beginButton}
                onClick={() => onBeginAnnotation(buildBatch(), null)}
              >
                Begin Annotation ({loadResult!.match!.matched.length} SKUs)
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface PathFieldProps {
  label: string
  value: string
  placeholder: string
  onPick: () => void
}

function PathField({ label, value, placeholder, onPick }: PathFieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <div className={styles.pathRow}>
        <span className={styles.pathDisplay}>
          {value !== '' ? value : <span className={styles.placeholder}>{placeholder}</span>}
        </span>
        <button className={styles.browseButton} onClick={onPick}>
          Browse
        </button>
      </div>
    </div>
  )
}

function ValidationResults({ result }: { result: BatchValidationResult }) {
  if (result.ok) {
    return (
      <div className={`${styles.results} ${styles.resultsOk}`}>
        <div className={styles.resultRow}>
          <span className={styles.ok}>✓</span>
          <span>
            Input folder found
            {result.imageCount !== undefined &&
              ` — ${result.imageCount} PNG ${result.imageCount === 1 ? 'file' : 'files'}`}
          </span>
        </div>
        <div className={styles.resultRow}>
          <span className={styles.ok}>✓</span>
          <span>Spreadsheet found</span>
        </div>
        <div className={styles.resultRow}>
          <span className={styles.ok}>✓</span>
          <span>Output folder found</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`${styles.results} ${styles.resultsError}`}>
      {result.errors.map((error, index) => (
        <div key={index} className={styles.resultRow}>
          <span className={styles.err}>✗</span>
          <span>{error}</span>
        </div>
      ))}
    </div>
  )
}

function BatchSummary({ result }: { result: BatchLoadResult }) {
  if (!result.ok) {
    return (
      <div className={`${styles.summary} ${styles.summaryError}`}>
        <div className={styles.summaryTitle}>Batch Analysis Failed</div>
        {result.errors.map((e, i) => (
          <div key={i} className={styles.resultRow}>
            <span className={styles.err}>✗</span>
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
    <div className={`${styles.summary} ${hasWarnings ? styles.summaryWarn : styles.summaryOk}`}>
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
        <button className={styles.beginButton} onClick={onResume}>
          Resume
        </button>
        <button className={styles.startFreshButton} onClick={onFresh}>
          Start fresh
        </button>
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
