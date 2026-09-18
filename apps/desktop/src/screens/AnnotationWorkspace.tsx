import { useRef, useState } from 'react'
import { AnnotationProvider, useAnnotation } from '../context/AnnotationContext'
import { QueueProvider, useQueue } from '../context/QueueContext'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
import { InfoPanel } from '../components/InfoPanel'
import { ProcessingQueue } from '../components/ProcessingQueue'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { useSessionAutosave } from '../hooks/useSessionAutosave'
import { BatchDashboard } from './BatchDashboard'
import type { AnnotationCanvasHandle } from '../components/AnnotationCanvas'
import type { BatchState } from '../types/annotation'
import type { SessionFile } from '../types/session'
import styles from './AnnotationWorkspace.module.css'

// ── Path helper (no Node.js path module in renderer) ─────────────────────────

function joinPath(dir: string, file: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + file
  return dir.includes('\\') ? `${dir}\\${file}` : `${dir}/${file}`
}

// ── Inner component — accesses both annotation and queue contexts ─────────────

function AnnotationContent({
  createdAt,
  onBack,
  onShowDashboard,
  onCompleteBatch,
}: {
  createdAt: string
  onBack(): void
  onShowDashboard(): void
  onCompleteBatch(): void
}) {
  const ctx = useAnnotation()
  const queue = useQueue()
  const { currentAnnotation, currentIndex, mode, batch } = ctx

  const canvasRef = useRef<AnnotationCanvasHandle>(null)

  const filePath = joinPath(batch.inputFolder, `${currentAnnotation.sku}.png`)
  const measureBy = ctx.currentRow?.measureBy ?? 'Case'

  useSessionAutosave(createdAt)

  function handleSubmit() {
    const guides = canvasRef.current?.getGuides()
    if (!guides) return

    const sku = ctx.currentAnnotation.sku
    const row = ctx.currentRow

    const spliceBoundaries = { leftBoundary: guides.spliceLeft, rightBoundary: guides.spliceRight }
    const scaleBoundaries =
      guides.scaleLeft !== null && guides.scaleRight !== null
        ? { leftBoundary: guides.scaleLeft, rightBoundary: guides.scaleRight }
        : null

    const { safeSplice, safeScale } = ctx.submitAnnotation(spliceBoundaries, scaleBoundaries)

    queue.addOptimistic(sku, { spliceBoundaries: safeSplice, scaleBoundaries: safeScale, widthMm: row.widthMm })

    void window.api.invoke('queue:add', {
      sku,
      inputFolder: ctx.batch.inputFolder,
      outputFolder: ctx.batch.outputFolder,
      spliceBoundaries: safeSplice,
      scaleBoundaries: safeScale,
      widthMm: row.widthMm,
    })
  }

  return (
    <div className={styles.workspace}>
      <AnnotationCanvas
        ref={canvasRef}
        watchKey={`${currentIndex}-${currentAnnotation.sku}`}
        filePath={filePath}
        // Phase 14C — an already-saved annotation always wins; otherwise
        // fall back to the live AI prediction for this SKU (null in manual
        // mode, or while nothing has been predicted yet — same 20%/80%/
        // inset defaults as before in that case).
        savedSpliceBoundaries={currentAnnotation.spliceBoundaries ?? ctx.currentSplicePrediction}
        savedScaleBoundaries={currentAnnotation.scaleBoundaries ?? ctx.currentScalePrediction}
        measureBy={measureBy}
        mode={mode}
        holdGuides={ctx.holdGuides}
      />
      <InfoPanel
        onSubmit={handleSubmit}
        onBack={onBack}
        onShowDashboard={onShowDashboard}
        onCompleteBatch={onCompleteBatch}
      />
      <ProcessingQueue />
    </div>
  )
}

// ── Outer component — provides contexts ──────────────────────────────────────

interface AnnotationWorkspaceProps {
  batch: BatchState
  initialSession: SessionFile | null
  onBack(): void
  // Explicit "Complete Batch" action (Phase 9E.1) — marks the Watch stage
  // completed and returns to Home; owned by App.tsx since it's the one that
  // knows which Batch this session belongs to.
  onCompleteBatch(): void
}

export function AnnotationWorkspace({ batch, initialSession, onBack, onCompleteBatch }: AnnotationWorkspaceProps) {
  const createdAt = useRef(initialSession?.createdAt ?? new Date().toISOString()).current
  const [view, setView] = useState<'annotation' | 'dashboard'>('annotation')

  return (
    <QueueProvider batch={batch} initialSession={initialSession}>
      <AnnotationProvider batch={batch} initialSession={initialSession}>
        <ErrorBoundary onBack={onBack}>
          {view === 'dashboard' ? (
            <BatchDashboard onBack={() => setView('annotation')} />
          ) : (
            <AnnotationContent
              createdAt={createdAt}
              onBack={onBack}
              onShowDashboard={() => setView('dashboard')}
              onCompleteBatch={onCompleteBatch}
            />
          )}
        </ErrorBoundary>
      </AnnotationProvider>
    </QueueProvider>
  )
}
