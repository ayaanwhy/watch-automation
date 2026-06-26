import { useEffect, useRef } from 'react'
import { useAnnotation } from '../context/AnnotationContext'
import { useQueue } from '../context/QueueContext'
import { SESSION_VERSION } from '../types/session'
import type { SessionFile, SessionQueueItem } from '../types/session'

export function useSessionAutosave(createdAt: string): void {
  const { batch, annotations, currentIndex, mode } = useAnnotation()
  const { items: queueItems } = useQueue()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(async () => {
      const processingQueue: SessionQueueItem[] = queueItems
        .filter(item => item.status !== 'pending')
        .map(item => ({
          id: item.id,
          sku: item.sku,
          leftBoundary: item.leftBoundary,
          rightBoundary: item.rightBoundary,
          widthMm: item.widthMm,
          // 'processing' means it was in-flight; on restore it will be re-queued.
          status: item.status === 'processing' ? 'queued' : (item.status as 'queued' | 'complete' | 'failed'),
          error: item.error,
          enqueuedAt: item.enqueuedAt,
          completedAt: item.completedAt,
        }))

      const session: SessionFile = {
        version: SESSION_VERSION,
        createdAt,
        updatedAt: new Date().toISOString(),
        inputFolder: batch.inputFolder,
        outputFolder: batch.outputFolder,
        spreadsheetPath: batch.spreadsheetPath,
        guideMode: mode,
        currentIndex,
        annotations: annotations.map(a => ({
          sku: a.sku,
          status: a.status,
          boundaries: a.boundaries,
        })),
        processingQueue,
        metadata: {},
      }
      await window.api.invoke('session:save', { outputFolder: batch.outputFolder, session })
    }, 400)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [annotations, currentIndex, mode, batch, createdAt, queueItems])
}
