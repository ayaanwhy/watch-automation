import { useRef } from 'react'
import { AnnotationProvider, useAnnotation } from '../context/AnnotationContext'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
import { InfoPanel } from '../components/InfoPanel'
import type { AnnotationCanvasHandle } from '../components/AnnotationCanvas'
import type { BatchState } from '../types/annotation'
import styles from './AnnotationWorkspace.module.css'

// ── Path helper (no Node.js path module in renderer) ─────────────────────────

function joinPath(dir: string, file: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + file
  return dir.includes('\\') ? `${dir}\\${file}` : `${dir}/${file}`
}

// ── Inner component — accesses context directly ───────────────────────────────

function AnnotationContent({ onBack }: { onBack(): void }) {
  const ctx = useAnnotation()
  const { currentAnnotation, currentIndex, mode, batch } = ctx

  const canvasRef = useRef<AnnotationCanvasHandle>(null)

  const filePath = joinPath(batch.inputFolder, `${currentAnnotation.sku}.png`)
  console.log('[AnnotationWorkspace] sku:', currentAnnotation.sku)
  console.log('[AnnotationWorkspace] filePath:', filePath)

  function handleSubmit() {
    const guides = canvasRef.current?.getGuides()
    if (!guides) return
    ctx.submitAnnotation(guides.left, guides.right)
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

// ── Outer component — provides context ───────────────────────────────────────

interface AnnotationWorkspaceProps {
  batch: BatchState
  onBack(): void
}

export function AnnotationWorkspace({ batch, onBack }: AnnotationWorkspaceProps) {
  return (
    <AnnotationProvider batch={batch}>
      <AnnotationContent onBack={onBack} />
    </AnnotationProvider>
  )
}
