import { createContext, useContext, useState, type ReactNode } from 'react'
import { MIN_GUIDE_SEPARATION } from '../types/annotation'
import type { BatchState, GuideMode, ProcessingStatus, WatchAnnotation } from '../types/annotation'
import type { SpreadsheetRowData } from '../types/ipc'
import type { SessionFile } from '../types/session'

interface AnnotationContextValue {
  batch: BatchState
  annotations: WatchAnnotation[]
  currentIndex: number
  mode: GuideMode
  currentAnnotation: WatchAnnotation
  currentRow: SpreadsheetRowData
  annotatedCount: number
  beginProcessing(left: number, right: number): { safeLeft: number; safeRight: number }
  setProcessingResult(sku: string, status: ProcessingStatus, error: string | null): void
  advance(): void
  navigate(delta: -1 | 1): void
  setMode(mode: GuideMode): void
}

const AnnotationContext = createContext<AnnotationContextValue | null>(null)

export function useAnnotation(): AnnotationContextValue {
  const ctx = useContext(AnnotationContext)
  if (!ctx) throw new Error('useAnnotation must be used within AnnotationProvider')
  return ctx
}

interface AnnotationProviderProps {
  batch: BatchState
  initialSession?: SessionFile | null
  children: ReactNode
}

export function AnnotationProvider({ batch, initialSession, children }: AnnotationProviderProps) {
  const [annotations, setAnnotations] = useState<WatchAnnotation[]>(() => {
    const saved = new Map(
      (initialSession?.annotations ?? []).map(a => [a.sku, a])
    )
    return batch.match.matched.map(sku => {
      const s = saved.get(sku)
      if (s) {
        // 'pending' means processing was in-flight when the session was saved — treat as not started.
        const pStatus = s.processingStatus === 'pending' ? null : (s.processingStatus ?? null)
        const pError = s.processingStatus === 'pending' ? null : (s.processingError ?? null)
        return { sku: s.sku, status: s.status, boundaries: s.boundaries, processingStatus: pStatus, processingError: pError }
      }
      return { sku, boundaries: null, status: 'unannotated' as const, processingStatus: null, processingError: null }
    })
  })

  const [currentIndex, setCurrentIndex] = useState(() => {
    if (!initialSession) return 0
    return Math.min(initialSession.currentIndex, batch.match.matched.length - 1)
  })

  const [mode, setMode] = useState<GuideMode>(() => initialSession?.guideMode ?? 'uniform')

  const total = annotations.length
  const currentAnnotation = annotations[currentIndex]
  const currentRow = batch.match.rows[currentAnnotation.sku]
  const annotatedCount = annotations.filter(a => a.status === 'annotated').length

  function beginProcessing(left: number, right: number): { safeLeft: number; safeRight: number } {
    const safeLeft = Math.round(Math.min(left, right - MIN_GUIDE_SEPARATION))
    const safeRight = Math.round(Math.max(right, left + MIN_GUIDE_SEPARATION))
    setAnnotations(prev =>
      prev.map((a, i) =>
        i === currentIndex
          ? {
              ...a,
              status: 'annotated',
              boundaries: { leftBoundary: safeLeft, rightBoundary: safeRight, source: 'manual', confidence: null },
              processingStatus: 'pending',
              processingError: null,
            }
          : a
      )
    )
    return { safeLeft, safeRight }
  }

  function setProcessingResult(sku: string, status: ProcessingStatus, error: string | null): void {
    setAnnotations(prev =>
      prev.map(a =>
        a.sku === sku ? { ...a, processingStatus: status, processingError: error } : a
      )
    )
  }

  function advance(): void {
    setCurrentIndex(prev => Math.min(prev + 1, total - 1))
  }

  function navigate(delta: -1 | 1) {
    setCurrentIndex(prev => Math.max(0, Math.min(prev + delta, total - 1)))
  }

  const value: AnnotationContextValue = {
    batch,
    annotations,
    currentIndex,
    mode,
    currentAnnotation,
    currentRow,
    annotatedCount,
    beginProcessing,
    setProcessingResult,
    advance,
    navigate,
    setMode,
  }

  return <AnnotationContext.Provider value={value}>{children}</AnnotationContext.Provider>
}
