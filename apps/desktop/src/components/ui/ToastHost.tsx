import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Toast, type ToastData } from './Toast'
import styles from './ToastHost.module.css'

type ToastInput = Omit<ToastData, 'id'>

interface ToastContextValue {
  showToast: (toast: ToastInput) => string
  dismissToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const AUTO_DISMISS_MS = 6000

// Provider + bottom-right stacking host for the Toast primitive (Phase
// 13B) — per Navigation's "Toasts (glass, bottom-right): batch completion
// ... and failures ... optional native macOS notification when the window
// is unfocused." This phase builds the mechanism only: mount
// <ToastProvider> once and call useToast() to show one. Nothing in the app
// does that yet — wiring job-completion events into it is 13C's "toast host
// wired to job completions," not this one.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([])
  const idRef = useRef(0)

  const dismissToast = useCallback((id: string) => {
    setToasts(current => current.filter(t => t.id !== id))
  }, [])

  const showToast = useCallback((toast: ToastInput) => {
    const id = String(++idRef.current)
    setToasts(current => [...current, { ...toast, id }])
    window.setTimeout(() => dismissToast(id), AUTO_DISMISS_MS)
    return id
  }, [dismissToast])

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div className={styles.host}>
        {toasts.map(toast => (
          <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
