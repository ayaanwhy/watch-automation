import { createContext, useContext, useState, type ReactNode } from 'react'
import { MIN_GUIDE_SEPARATION } from '../types/annotation'
import type { BatchState, BoundaryData, GuideMode, WatchAnnotation } from '../types/annotation'
import type { SpreadsheetRowData } from '../types/ipc'
import type { SessionFile } from '../types/session'

type SimpleBoundary = { leftBoundary: number; rightBoundary: number }

interface AnnotationContextValue {
  batch: BatchState
  annotations: WatchAnnotation[]
  currentIndex: number
  mode: GuideMode
  currentAnnotation: WatchAnnotation
  currentRow: SpreadsheetRowData
  annotatedCount: number
  submitAnnotation(
    splice: SimpleBoundary,
    scale: SimpleBoundary | null
  ): { safeSplice: BoundaryData; safeScale: BoundaryData | null }
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

function clampBoundary(b: SimpleBoundary): BoundaryData {
  const safeLeft = Math.round(Math.min(b.leftBoundary, b.rightBoundary - MIN_GUIDE_SEPARATION))
  const safeRight = Math.round(Math.max(b.rightBoundary, b.leftBoundary + MIN_GUIDE_SEPARATION))
  return { leftBoundary: safeLeft, rightBoundary: safeRight, source: 'manual', confidence: null }
}

export function AnnotationProvider({ batch, initialSession, children }: AnnotationProviderProps) {
  const [annotations, setAnnotations] = useState<WatchAnnotation[]>(() => {
    const saved = new Map(
      (initialSession?.annotations ?? []).map(a => [a.sku, a])
    )
    return batch.match.matched.map(sku => {
      const s = saved.get(sku)
      if (s) {
        return {
          sku: s.sku,
          status: s.status,
          spliceBoundaries: s.spliceBoundaries,
          scaleBoundaries: s.scaleBoundaries,
        }
      }
      return { sku, status: 'unannotated' as const, spliceBoundaries: null, scaleBoundaries: null }
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

  function submitAnnotation(
    splice: SimpleBoundary,
    scale: SimpleBoundary | null
  ): { safeSplice: BoundaryData; safeScale: BoundaryData | null } {
    const safeSplice = clampBoundary(splice)
    const safeScale = scale ? clampBoundary(scale) : null

    setAnnotations(prev =>
      prev.map((a, i) =>
        i === currentIndex
          ? { ...a, status: 'annotated', spliceBoundaries: safeSplice, scaleBoundaries: safeScale }
          : a
      )
    )
    setCurrentIndex(prev => Math.min(prev + 1, total - 1))
    return { safeSplice, safeScale }
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
