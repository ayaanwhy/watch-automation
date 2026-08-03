import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  // 'tile' matches Select.tsx's form-control language (Editing product
  // choice, handoff dialog options). 'pill' reproduces the compact preview-
  // toolbar look BeforeAfterSlider's background toggle already used before
  // this component existed (Phase 10F) — same interaction, different sizing
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
//
// Phase 13B — gained a real sliding thumb (measured against each option's
// DOM rect, animated on the shared spring easing): per Component System,
// "it appears everywhere (products, modes, filters), so its motion is the
// app's signature." Kept graphite (surface-3 thumb, not accent) per the
// violet restraint rules — "Filters... all graphite" — the motion carries
// the affordance, not the color.
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
  const optionRefs = useRef(new Map<T, HTMLButtonElement>())
  const [thumbRect, setThumbRect] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const el = optionRefs.current.get(value)
    if (el) setThumbRect({ left: el.offsetLeft, width: el.offsetWidth })
    else setThumbRect(null)
  }, [value, options, variant])

  useEffect(() => {
    function handleResize() {
      const el = optionRefs.current.get(value)
      if (el) setThumbRect({ left: el.offsetLeft, width: el.offsetWidth })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [value])

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      {label && <label className={styles.label}>{label}</label>}
      <div className={`${styles.group} ${styles[variant]}`} role="group" aria-label={ariaLabel ?? label}>
        {thumbRect && (
          <div
            className={styles.thumb}
            style={{ transform: `translateX(${thumbRect.left}px)`, width: thumbRect.width }}
            aria-hidden="true"
          />
        )}
        {options.map(opt => {
          const optionDisabled = groupDisabled || opt.disabled
          return (
            <button
              key={opt.value}
              ref={el => {
                if (el) optionRefs.current.set(opt.value, el)
                else optionRefs.current.delete(opt.value)
              }}
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
