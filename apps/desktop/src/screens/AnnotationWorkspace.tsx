import { useRef } from 'react'
import { AnnotationProvider, useAnnotation } from '../context/AnnotationContext'
import { QueueProvider, useQueue } from '../context/QueueContext'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
import { InfoPanel } from '../components/InfoPanel'
import { ProcessingQueue } from '../components/ProcessingQueue'
import { useSessionAutosave } from '../hooks/useSessionAutosave'
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

function AnnotationContent({ createdAt, onBack }: { createdAt: string; onBack(): void }) {
  const ctx = useAnnotation()
  const queue = useQueue()
  const { currentAnnotation, currentIndex, mode, batch } = ctx

  const canvasRef = useRef<AnnotationCanvasHandle>(null)

  const filePath = joinPath(batch.inputFolder, `${currentAnnotation.sku}.png`)

  useSessionAutosave(createdAt)

  function handleSubmit() {
    const guides = canvasRef.current?.getGuides()
    if (!guides) return

    const sku = ctx.currentAnnotation.sku
    const row = ctx.currentRow

    const { safeLeft, safeRight } = ctx.submitAnnotation(guides.left, guides.right)

    queue.addOptimistic(sku, { leftBoundary: safeLeft, rightBoundary: safeRight, widthMm: row.widthMm })

    void window.api.invoke('queue:add', {
      sku,
      inputFolder: ctx.batch.inputFolder,
      outputFolder: ctx.batch.outputFolder,
      leftBoundary: safeLeft,
      rightBoundary: safeRight,
      widthMm: row.widthMm,
    })
  }

  return (
    <div className={styles.workspace}>
      <AnnotationCanvas
        ref={canvasRef}
        watchKey={`${currentIndex}-${currentAnnotation.sku}`}
        filePath={filePath}
        savedBoundaries={currentAnnotation.boundaries}
        mode={mode}
      />
      <InfoPanel onSubmit={handleSubmit} onBack={onBack} />
    </div>
  )
}

// ── Outer component — provides contexts ──────────────────────────────────────

interface AnnotationWorkspaceProps {
  batch: BatchState
  initialSession: SessionFile | null
  onBack(): void
}

export function AnnotationWorkspace({ batch, initialSession, onBack }: AnnotationWorkspaceProps) {
  const createdAt = useRef(initialSession?.createdAt ?? new Date().toISOString()).current

  return (
    <QueueProvider batch={batch} initialSession={initialSession}>
      <AnnotationProvider batch={batch} initialSession={initialSession}>
        <AnnotationContent createdAt={createdAt} onBack={onBack} />
        <ProcessingQueue />
      </AnnotationProvider>
    </QueueProvider>
  )
}
