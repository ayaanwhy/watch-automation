import { useAnnotation } from '../context/AnnotationContext'
import styles from './InfoPanel.module.css'

interface InfoPanelProps {
  onSubmit(): void
  onBack(): void
}

export function InfoPanel({ onSubmit, onBack }: InfoPanelProps) {
  const { batch, annotations, currentIndex, mode, currentAnnotation, currentRow, annotatedCount, navigate, setMode } =
    useAnnotation()

  const total = annotations.length
  const isFirst = currentIndex === 0
  const isLast = currentIndex === total - 1

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onBack}>
          ← Back
        </button>
        <span className={styles.batchLabel}>Batch</span>
      </div>

      <section className={styles.section}>
        <div className={styles.skuValue}>{currentAnnotation.sku}</div>
        <div className={styles.statusBadge} data-status={currentAnnotation.status}>
          {currentAnnotation.status === 'annotated' ? 'Annotated' : 'Unannotated'}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Measurements</div>
        <MetaRow label="Width" value={`${currentRow?.widthMm ?? '—'} mm`} />
        <MetaRow label="Height" value={`${currentRow?.heightMm ?? '—'} mm`} />
        <MetaRow label="Measure By" value={currentRow?.measureBy ?? '—'} />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Progress</div>
        <div className={styles.progressRow}>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${total > 0 ? (annotatedCount / total) * 100 : 0}%` }}
            />
          </div>
          <span className={styles.progressCount}>
            {annotatedCount} / {total}
          </span>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Guide Mode</div>
        <div className={styles.modeToggle}>
          <button
            className={styles.modeButton}
            data-active={mode === 'uniform'}
            onClick={() => setMode('uniform')}
          >
            Uniform
          </button>
          <button
            className={styles.modeButton}
            data-active={mode === 'free'}
            onClick={() => setMode('free')}
          >
            Free
          </button>
        </div>
        <p className={styles.modeHint}>
          {mode === 'uniform'
            ? 'Both guides mirror around dial center'
            : 'Guides move independently'}
        </p>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLabel}>Keyboard</div>
        <div className={styles.keyHints}>
          <KeyHint keys={['←', '→']} label="Nudge 1px" />
          <KeyHint keys={['⇧←', '⇧→']} label="Nudge 10px" />
        </div>
      </section>

      <div className={styles.controls}>
        <div className={styles.navRow}>
          <button className={styles.navButton} onClick={() => navigate(-1)} disabled={isFirst}>
            Previous
          </button>
          <span className={styles.indexLabel}>
            {currentIndex + 1} of {total}
          </span>
          <button className={styles.navButton} onClick={() => navigate(1)} disabled={isLast}>
            Next
          </button>
        </div>

        <button className={styles.submitButton} onClick={onSubmit}>
          Submit
        </button>
      </div>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metaRow}>
      <span className={styles.metaLabel}>{label}</span>
      <span className={styles.metaValue}>{value}</span>
    </div>
  )
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className={styles.keyHint}>
      <span className={styles.keyHintKeys}>
        {keys.map(k => (
          <kbd key={k} className={styles.kbd}>
            {k}
          </kbd>
        ))}
      </span>
      <span className={styles.keyHintLabel}>{label}</span>
    </div>
  )
}
