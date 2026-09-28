import { AUTOMATION_STAGE_LABELS, type AutomationError } from '../types/automationError'
import styles from './AutomationErrorNotice.module.css'

interface AutomationErrorNoticeProps {
  error: AutomationError
  // Compact = one tight block (used per image); default is roomier.
  compact?: boolean
}

// Renders a structured AutomationError the same way everywhere (run, product
// and image level): WHAT failed and WHERE, the concise message, what to do
// next, whether retrying can help — and the raw technical detail only behind
// an expander, never as the primary message.
export function AutomationErrorNotice({ error, compact }: AutomationErrorNoticeProps) {
  const where = error.stageDetail ? `${AUTOMATION_STAGE_LABELS[error.stage]} · ${error.stageDetail}` : AUTOMATION_STAGE_LABELS[error.stage]
  return (
    <div className={[styles.notice, compact ? styles.compact : ''].join(' ').trim()} role="alert">
      <div className={styles.head}>
        <span aria-hidden="true">✕</span>
        <span className={styles.where}>{where}</span>
        <span className={styles.retry}>{error.retryable ? 'Retryable' : 'Fix required'}</span>
      </div>
      <p className={styles.message}>{error.message}</p>
      {error.action && <p className={styles.action}>{error.action}</p>}
      {(error.technicalMessage || error.cause) && (
        <details className={styles.details}>
          <summary>Technical details</summary>
          <pre>
            {[`code: ${error.code}`, error.cause ? `cause: ${error.cause}` : null, error.technicalMessage].filter(Boolean).join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}
