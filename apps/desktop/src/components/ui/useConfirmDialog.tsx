import { useCallback, useRef, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'

interface ConfirmOptions {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
}

interface PendingConfirm extends ConfirmOptions {
  message: string
}

// Promise-based replacement for window.confirm (Phase 13B — Component
// System's "standard destructive-confirm variant retires window.confirm").
// `confirm(message)` resolves true/false exactly like the browser API it
// replaces, so an existing `if (!window.confirm(msg)) return` call site
// inside an already-async function becomes `if (!(await confirm(msg)))
// return` — a one-line swap, no control-flow restructuring. Render
// `{dialog}` once, anywhere in the calling component's tree.
export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const resolveRef = useRef<(result: boolean) => void>()

  const confirm = useCallback((message: string, options?: ConfirmOptions) => {
    return new Promise<boolean>(resolve => {
      resolveRef.current = resolve
      setPending({ message, ...options })
    })
  }, [])

  function settle(result: boolean) {
    resolveRef.current?.(result)
    resolveRef.current = undefined
    setPending(null)
  }

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.title ?? 'Confirm'}
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      tone={pending.tone}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null

  return { confirm, dialog }
}
