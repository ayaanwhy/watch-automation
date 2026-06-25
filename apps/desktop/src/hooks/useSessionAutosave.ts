import { useEffect, useRef } from 'react'
import { useAnnotation } from '../context/AnnotationContext'
import { SESSION_VERSION } from '../types/session'
import type { SessionFile } from '../types/session'

export function useSessionAutosave(createdAt: string): void {
  const { batch, annotations, currentIndex, mode } = useAnnotation()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(async () => {
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
          processingStatus: a.processingStatus,
          processingError: a.processingError,
        })),
        metadata: {},
      }
      await window.api.invoke('session:save', { outputFolder: batch.outputFolder, session })
    }, 400)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [annotations, currentIndex, mode, batch, createdAt])
}
