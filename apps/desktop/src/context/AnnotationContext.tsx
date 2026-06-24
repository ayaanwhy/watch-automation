import { createContext, useContext, useState, type ReactNode } from 'react'
import { MIN_GUIDE_SEPARATION } from '../types/annotation'
import type { BatchState, GuideMode, WatchAnnotation } from '../types/annotation'
import type { SpreadsheetRowData } from '../types/ipc'

interface AnnotationContextValue {
  batch: BatchState
  annotations: WatchAnnotation[]
  currentIndex: number
  mode: GuideMode
  currentAnnotation: WatchAnnotation
  currentRow: SpreadsheetRowData
  annotatedCount: number
  submitAnnotation(left: number, right: number): void
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
  children: ReactNode
}

export function AnnotationProvider({ batch, children }: AnnotationProviderProps) {
  const [annotations, setAnnotations] = useState<WatchAnnotation[]>(() =>
    batch.match.matched.map(sku => ({ sku, boundaries: null, status: 'unannotated' as const }))
  )
  const [currentIndex, setCurrentIndex] = useState(0)
  const [mode, setMode] = useState<GuideMode>('uniform')

  const total = annotations.length
  const currentAnnotation = annotations[currentIndex]
  const currentRow = batch.match.rows[currentAnnotation.sku]
  const annotatedCount = annotations.filter(a => a.status === 'annotated').length

  function submitAnnotation(left: number, right: number) {
    const safeLeft = Math.round(Math.min(left, right - MIN_GUIDE_SEPARATION))
    const safeRight = Math.round(Math.max(right, left + MIN_GUIDE_SEPARATION))
    setAnnotations(prev =>
      prev.map((a, i) =>
        i === currentIndex
          ? {
              ...a,
              status: 'annotated',
              boundaries: { leftBoundary: safeLeft, rightBoundary: safeRight, source: 'manual', confidence: null }
            }
          : a
      )
    )
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
    submitAnnotation,
    navigate,
    setMode,
  }

  return <AnnotationContext.Provider value={value}>{children}</AnnotationContext.Provider>
}
