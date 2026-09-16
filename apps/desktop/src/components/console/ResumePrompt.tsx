import { Button } from '../ui/Button'
import styles from './ResumePrompt.module.css'

// Shared "we found unfinished prior work at these exact paths" prompt —
// originally Watch/BatchSetup's own local component (SessionFile-driven
// annotation progress), extracted (post-Phase-13 polish) so Ring/Bracelet/
// Earring's editing-batch resume can present the identical Resume/Start
// Fresh affordance without a second implementation. Purely presentational —
// callers supply their own label/detail text and count semantics (Watch's
// "annotated"; Ring/Bracelet/Earring's "processed").
interface ResumePromptProps {
  label: string
  detail: string
  onResume(): void
  onFresh(): void
}

export function ResumePrompt({ label, detail, onResume, onFresh }: ResumePromptProps) {
  return (
    <div className={styles.resumePrompt}>
      <div className={styles.resumeInfo}>
        <span className={styles.resumeLabel}>{label}</span>
        <span className={styles.resumeCount}>{detail}</span>
      </div>
      <div className={styles.resumeActions}>
        <Button variant="primary" onClick={onResume}>Resume</Button>
        <Button variant="secondary" onClick={onFresh}>Start fresh</Button>
      </div>
    </div>
  )
}
