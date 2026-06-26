import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { QueueItemPublic } from '../types/ipc'
import type { SessionFile, SessionQueueItem } from '../types/session'

interface QueueContextValue {
  items: QueueItemPublic[]
  addOptimistic(sku: string, params: { leftBoundary: number; rightBoundary: number; widthMm: number }): void
  retryItem(id: string): void
}

const QueueContext = createContext<QueueContextValue | null>(null)

export function useQueue(): QueueContextValue {
  const ctx = useContext(QueueContext)
  if (!ctx) throw new Error('useQueue must be used within QueueProvider')
  return ctx
}

interface QueueProviderProps {
  batch: { inputFolder: string; outputFolder: string }
  initialSession: SessionFile | null
  children: ReactNode
}

export function QueueProvider({ batch, initialSession, children }: QueueProviderProps) {
  // Items confirmed by the main process (received via queue:get or queue:update).
  const [mainItems, setMainItems] = useState<QueueItemPublic[]>([])

  // Optimistic renderer-side items: added immediately on Submit before the main process acknowledges.
  // Keyed by SKU; removed when the same SKU appears in mainItems.
  const [pendingItems, setPendingItems] = useState<QueueItemPublic[]>([])

  const autoExpandedRef = useRef(false)

  useEffect(() => {
    // Load current queue snapshot (handles hot reload / navigation back to workspace).
    void (window.api.invoke('queue:get') as Promise<QueueItemPublic[]>).then(items => {
      setMainItems(items)
    })

    // Subscribe to push updates from the main process.
    const unsubscribe = window.api.on('queue:update', (items) => {
      const incoming = items as QueueItemPublic[]
      setMainItems(incoming)
      // Drop optimistic pending entries whose SKU the main process now acknowledges.
      setPendingItems(prev => prev.filter(p => !incoming.some(m => m.sku === p.sku)))
    })

    // Restore queue from a prior session.
    if (initialSession?.processingQueue && initialSession.processingQueue.length > 0) {
      void window.api.invoke('queue:restore', {
        items: initialSession.processingQueue as SessionQueueItem[],
        inputFolder: batch.inputFolder,
        outputFolder: batch.outputFolder,
      })
    }

    return () => { unsubscribe() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Pending items are shown only for SKUs not yet in the main queue.
  const activePending = pendingItems.filter(p => !mainItems.some(m => m.sku === p.sku))

  // Main items first (submission order), then unacknowledged pending items at the end.
  const items: QueueItemPublic[] = [...mainItems, ...activePending]

  function addOptimistic(
    sku: string,
    params: { leftBoundary: number; rightBoundary: number; widthMm: number }
  ): void {
    setPendingItems(prev => {
      // Skip if already pending for this SKU.
      if (prev.some(p => p.sku === sku)) return prev
      const optimistic: QueueItemPublic = {
        id: `pending-${Date.now()}`,
        sku,
        status: 'pending',
        error: null,
        enqueuedAt: new Date().toISOString(),
        completedAt: null,
        leftBoundary: params.leftBoundary,
        rightBoundary: params.rightBoundary,
        widthMm: params.widthMm,
      }
      return [...prev, optimistic]
    })
  }

  function retryItem(id: string): void {
    void window.api.invoke('queue:retry', { id })
  }

  // Auto-expand the queue panel when the first item arrives.
  // Stored in a ref so it only fires once per provider lifetime.
  if (items.length > 0 && !autoExpandedRef.current) {
    autoExpandedRef.current = true
  }

  return (
    <QueueContext.Provider value={{ items, addOptimistic, retryItem }}>
      {children}
    </QueueContext.Provider>
  )
}
