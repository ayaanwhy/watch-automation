import styles from './SegmentedControl.module.css'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  // Visible but not selectable — mirrors Select.tsx's SelectOption.disabled
  // (e.g. a roadmap product/destination not implemented yet).
  disabled?: boolean
}

export type SegmentedControlVariant = 'tile' | 'pill'

interface SegmentedControlProps<T extends string> {
  label?: string
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  // 'tile' matches Select.tsx's light form-control language (Editing product
  // choice, handoff dialog options). 'pill' reproduces the dark preview-
  // toolbar look BeforeAfterSlider's background toggle already used before
  // this component existed (Phase 10F) — same interaction, different skin
  // for a different visual context, not a second component.
  variant?: SegmentedControlVariant
  'aria-label'?: string
  className?: string
  // Disables every option regardless of its own per-option `disabled` (Phase
  // 12C) — for a control whose whole group is temporarily locked (e.g.
  // EditingHandoffDialog's Rotate control while Earring is selected), rather
  // than the per-option flag's "this one choice isn't implemented yet".
  disabled?: boolean
}

// All-options-visible segmented/tile selector — the toggle-group counterpart
// to Select.tsx's popup dropdown. Same generic SelectOption-shaped API
// deliberately, so callers can reuse the same options list, but this is a
// genuinely different interaction (no open/close state, every option always
// visible) rather than a Select variant.
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  variant = 'tile',
  'aria-label': ariaLabel,
  className,
  disabled: groupDisabled,
}: SegmentedControlProps<T>) {
  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      {label && <label className={styles.label}>{label}</label>}
      <div className={`${styles.group} ${styles[variant]}`} role="group" aria-label={ariaLabel ?? label}>
        {options.map(opt => {
          const optionDisabled = groupDisabled || opt.disabled
          return (
            <button
              key={opt.value}
              type="button"
              className={[styles.option, opt.value === value ? styles.optionActive : ''].join(' ').trim()}
              disabled={optionDisabled}
              aria-pressed={opt.value === value}
              aria-disabled={optionDisabled || undefined}
              onClick={optionDisabled ? undefined : () => onChange(opt.value)}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
