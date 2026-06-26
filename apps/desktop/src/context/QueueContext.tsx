import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { QueueItemPublic } from '../types/ipc'
import type { SessionFile, SessionQueueItem } from '../types/session'

interface AddOptimisticParams {
  spliceBoundaries: { leftBoundary: number; rightBoundary: number }
  scaleBoundaries: { leftBoundary: number; rightBoundary: number } | null
  widthMm: number
}

interface QueueContextValue {
  items: QueueItemPublic[]
  addOptimistic(sku: string, params: AddOptimisticParams): void
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
  // Items confirmed by the main process.
  const [mainItems, setMainItems] = useState<QueueItemPublic[]>([])

  // Optimistic renderer-side items: added immediately on Submit before the main process
  // acknowledges. Removed when the same SKU appears in mainItems.
  const [pendingItems, setPendingItems] = useState<QueueItemPublic[]>([])

  useEffect(() => {
    void (window.api.invoke('queue:get') as Promise<QueueItemPublic[]>).then(items => {
      setMainItems(items)
    })

    const unsubscribe = window.api.on('queue:update', (items) => {
      const incoming = items as QueueItemPublic[]
      setMainItems(incoming)
      setPendingItems(prev => prev.filter(p => !incoming.some(m => m.sku === p.sku)))
    })

    if (initialSession?.processingQueue && initialSession.processingQueue.length > 0) {
      void window.api.invoke('queue:restore', {
        items: initialSession.processingQueue as SessionQueueItem[],
        inputFolder: batch.inputFolder,
        outputFolder: batch.outputFolder,
      })
    }

    return () => { unsubscribe() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Pending items shown only for SKUs not yet in the confirmed queue.
  const activePending = pendingItems.filter(p => !mainItems.some(m => m.sku === p.sku))

  // Confirmed items first (submission order), then unacknowledged pending at the end.
  const items: QueueItemPublic[] = [...mainItems, ...activePending]

  function addOptimistic(sku: string, params: AddOptimisticParams): void {
    setPendingItems(prev => {
      if (prev.some(p => p.sku === sku)) return prev
      const optimistic: QueueItemPublic = {
        id: `pending-${Date.now()}`,
        sku,
        status: 'pending',
        error: null,
        enqueuedAt: new Date().toISOString(),
        completedAt: null,
        spliceBoundaries: params.spliceBoundaries,
        scaleBoundaries: params.scaleBoundaries,
        widthMm: params.widthMm,
      }
      return [...prev, optimistic]
    })
  }

  function retryItem(id: string): void {
    void window.api.invoke('queue:retry', { id })
  }

  return (
    <QueueContext.Provider value={{ items, addOptimistic, retryItem }}>
      {children}
    </QueueContext.Provider>
  )
}
