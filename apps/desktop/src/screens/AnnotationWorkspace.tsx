import { useRef, useState } from 'react'
import { AnnotationProvider, useAnnotation } from '../context/AnnotationContext'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
import { InfoPanel } from '../components/InfoPanel'
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

// ── Inner component — accesses context directly ───────────────────────────────

function AnnotationContent({ createdAt, onBack }: { createdAt: string; onBack(): void }) {
  const ctx = useAnnotation()
  const { currentAnnotation, currentIndex, mode, batch } = ctx
  const [isSubmitting, setIsSubmitting] = useState(false)

  const canvasRef = useRef<AnnotationCanvasHandle>(null)

  const filePath = joinPath(batch.inputFolder, `${currentAnnotation.sku}.png`)

  useSessionAutosave(createdAt)

  async function handleSubmit() {
    const guides = canvasRef.current?.getGuides()
    if (!guides || isSubmitting) return

    const sku = ctx.currentAnnotation.sku
    const row = ctx.currentRow

    setIsSubmitting(true)

    const { safeLeft, safeRight } = ctx.beginProcessing(guides.left, guides.right)

    const result = await window.api.invoke('process:watch', {
      inputFolder: ctx.batch.inputFolder,
      outputFolder: ctx.batch.outputFolder,
      sku,
      leftBoundary: safeLeft,
      rightBoundary: safeRight,
      widthMm: row.widthMm,
    })

    ctx.setProcessingResult(sku, result.ok ? 'complete' : 'failed', result.ok ? null : (result.error ?? 'Processing failed'))

    if (result.ok) {
      ctx.advance()
    }

    setIsSubmitting(false)
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
      <InfoPanel onSubmit={handleSubmit} onBack={onBack} isSubmitting={isSubmitting} />
    </div>
  )
}

// ── Outer component — provides context ───────────────────────────────────────

interface AnnotationWorkspaceProps {
  batch: BatchState
  initialSession: SessionFile | null
  onBack(): void
}

export function AnnotationWorkspace({ batch, initialSession, onBack }: AnnotationWorkspaceProps) {
  const createdAt = useRef(initialSession?.createdAt ?? new Date().toISOString()).current

  return (
    <AnnotationProvider batch={batch} initialSession={initialSession}>
      <AnnotationContent createdAt={createdAt} onBack={onBack} />
    </AnnotationProvider>
  )
}
