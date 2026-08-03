import { Check } from 'lucide-react'
import type { PreprocessingPreset } from '../../constants/preprocessingPresets'
import styles from './PresetCards.module.css'

export interface PresetCardOption {
  value: PreprocessingPreset
  label: string
  description: string
  // True when the live definition (Settings-editable) diverges from the
  // factory default — see constants/preprocessingPresets.ts's
  // isPresetModified.
  modified: boolean
  version: number
}

interface PresetCardsProps {
  options: PresetCardOption[]
  value: PreprocessingPreset
  onChange: (value: PreprocessingPreset) => void
  disabled?: boolean
}

// Replaces the Preset Select dropdown + separate helper-text paragraph
// (Phase 13E, Component System: "Presets render as three selectable cards
// (name, one-line tradeoff, 'customized' marker when definitions diverge
// from defaults) instead of a dropdown + helper text").
export function PresetCards({ options, value, onChange, disabled }: PresetCardsProps) {
  return (
    <div className={styles.grid} role="radiogroup" aria-label="Preset">
      {options.map(opt => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`${styles.card} ${active ? styles.cardActive : ''}`}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
          >
            <span className={styles.cardHeader}>
              <span className={styles.cardLabel}>{opt.label}</span>
              {active && <Check size={14} strokeWidth={2} className={styles.check} aria-hidden="true" />}
            </span>
            <span className={styles.cardDescription}>{opt.description}</span>
            {opt.modified && <span className={styles.modifiedBadge}>Customized · v{opt.version}</span>}
          </button>
        )
      })}
    </div>
  )
}
