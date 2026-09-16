import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import styles from './Select.module.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
  // Visible but not selectable — e.g. a roadmap product not implemented yet.
  disabled?: boolean
  // Optional second line rendered under the label in the popover (Phase
  // 13B) — e.g. a preset's one-line tradeoff. Absent for options that don't
  // need one; the trigger only ever shows the label.
  description?: string
}

interface SelectProps<T extends string> {
  label?: string
  options: SelectOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  // Trigger reads as "on" (accent border + tinted fill) — for a Select used
  // as a filter control, where a non-default value needs the same
  // obviously-active signal SegmentedControl gets for free from its pill
  // highlight. Purely visual; callers decide what "active" means (e.g.
  // value !== 'all').
  active?: boolean
}

// Generic custom dropdown matching the app's own form-control language,
// rather than the browser's stock <select> chrome — an opaque surface-3
// popover per the glass doctrine (popovers/menus stay opaque for text
// legibility; glass is reserved for the four sanctioned surfaces). No new
// dependency — a trigger button + an absolutely-positioned listbox, closing
// on outside click or Escape, with standard ARIA listbox semantics.
export function Select<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  active = false,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find(o => o.value === value)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className={styles.field} ref={rootRef}>
      {label && <label className={styles.label}>{label}</label>}
      <div className={styles.selectRoot}>
        <button
          type="button"
          className={active ? `${styles.trigger} ${styles.triggerActive}` : styles.trigger}
          onClick={() => !disabled && setOpen(o => !o)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className={styles.triggerLabel}>{current?.label ?? ''}</span>
          <ChevronDown
            size={16}
            strokeWidth={1.5}
            className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
            aria-hidden="true"
          />
        </button>
        {open && (
          <ul className={styles.menu} role="listbox">
            {options.map(opt => (
              <li
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                aria-disabled={opt.disabled || undefined}
                className={[
                  styles.option,
                  opt.value === value ? styles.optionActive : '',
                  opt.disabled ? styles.optionDisabled : '',
                ].join(' ').trim()}
                onClick={
                  opt.disabled
                    ? undefined
                    : () => {
                        onChange(opt.value)
                        setOpen(false)
                      }
                }
              >
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>{opt.label}</span>
                  {opt.description && <span className={styles.optionDescription}>{opt.description}</span>}
                </span>
                {opt.value === value && <Check size={14} strokeWidth={1.5} className={styles.optionCheck} aria-hidden="true" />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
