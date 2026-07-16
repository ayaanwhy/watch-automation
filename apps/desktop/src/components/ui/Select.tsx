import { useEffect, useRef, useState } from 'react'
import styles from './Select.module.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
  // Visible but not selectable — e.g. a roadmap product not implemented yet.
  disabled?: boolean
}

interface SelectProps<T extends string> {
  label?: string
  options: SelectOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}

// Generic custom dropdown matching the app's own form-control language,
// rather than the browser's stock <select> chrome. No new dependency —
// a trigger button + an absolutely-positioned listbox, closing on outside
// click or Escape, with standard ARIA listbox semantics.
export function Select<T extends string>({ label, options, value, onChange, disabled = false }: SelectProps<T>) {
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
          className={styles.trigger}
          onClick={() => !disabled && setOpen(o => !o)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className={styles.triggerLabel}>{current?.label ?? ''}</span>
          <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">⌄</span>
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
                {opt.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
