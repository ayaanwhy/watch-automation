import type { SamTuningPrefs } from '../types/ipc'
import styles from './SamTuningPanel.module.css'

interface SamTuningPanelProps {
  prefs: SamTuningPrefs
  onUpdate: <K extends keyof SamTuningPrefs>(key: K, value: SamTuningPrefs[K]) => void
}

export function SamTuningPanel({ prefs, onUpdate }: SamTuningPanelProps) {
  return (
    <details className={styles.details}>
      <summary className={styles.summary}>SAM Tuning</summary>

      <div className={styles.grid}>
        <label className={styles.label}>Points per Side</label>
        <input
          className={styles.input}
          type="number"
          min={1}
          max={64}
          step={1}
          value={prefs.pointsPerSide}
          onChange={e => onUpdate('pointsPerSide', Math.max(1, parseInt(e.target.value) || 1))}
        />

        <label className={styles.label}>Points per Batch</label>
        <input
          className={styles.input}
          type="number"
          min={1}
          max={256}
          step={1}
          value={prefs.pointsPerBatch}
          onChange={e => onUpdate('pointsPerBatch', Math.max(1, parseInt(e.target.value) || 1))}
        />

        <label className={styles.label}>Pred IoU Threshold</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={prefs.predIouThresh}
          onChange={e => onUpdate('predIouThresh', Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)))}
        />

        <label className={styles.label}>Stability Score Threshold</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={prefs.stabilityScoreThresh}
          onChange={e => onUpdate('stabilityScoreThresh', Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)))}
        />

        <label className={styles.label}>Max Masks</label>
        <input
          className={styles.input}
          type="number"
          min={1}
          max={256}
          step={1}
          value={prefs.maxMasks}
          onChange={e => onUpdate('maxMasks', Math.max(1, parseInt(e.target.value) || 1))}
        />

        <label className={styles.label}>Multimask Output</label>
        <input
          className={styles.checkbox}
          type="checkbox"
          checked={prefs.multimaskOutput}
          onChange={e => onUpdate('multimaskOutput', e.target.checked)}
        />
      </div>
    </details>
  )
}
