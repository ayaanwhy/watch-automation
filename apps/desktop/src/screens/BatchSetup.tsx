import { useState } from 'react'
import type { BatchValidationResult, BatchLoadResult, MatchSummary, OpenFileOptions } from '../types/ipc'
import styles from './BatchSetup.module.css'

export default function BatchSetup() {
  const [inputFolder, setInputFolder] = useState('')
  const [spreadsheetPath, setSpreadsheetPath] = useState('')
  const [outputFolder, setOutputFolder] = useState('')
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null)
  const [pathResult, setPathResult] = useState<BatchValidationResult | null>(null)
  const [loadResult, setLoadResult] = useState<BatchLoadResult | null>(null)

  const canValidate = inputFolder !== '' && spreadsheetPath !== '' && outputFolder !== ''
  const isLoading = loadingMsg !== null

  function clearResults() {
    setPathResult(null)
    setLoadResult(null)
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

  async function handleValidate() {
    if (!canValidate || isLoading) return

    setPathResult(null)
    setLoadResult(null)
    setLoadingMsg('Validating…')

    try {
      const validation = await window.api.invoke('batch:validate', {
        inputFolder,
        spreadsheetPath,
        outputFolder
      })
      setPathResult(validation)

      if (validation.ok) {
        setLoadingMsg('Analyzing batch…')
        const load = await window.api.invoke('batch:load', { inputFolder, spreadsheetPath })
        setLoadResult(load)
      }
    } finally {
      setLoadingMsg(null)
    }
  }

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
      </div>
    </div>
  )
}

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
