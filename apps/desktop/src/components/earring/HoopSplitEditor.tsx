import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import styles from './HoopSplitEditor.module.css'

// Mirrors hoop_mask.py's EDGE_SAFE_FRACTION exactly (Phase 12D/12E) — kept as
// an independent constant, not shared code, since there is no shared
// TS/Python module boundary here; the two are documented as intentionally
// identical so the UI never lets an operator place a split the runner's own
// safety clamp would immediately reject as implausible.
const EDGE_SAFE_FRACTION = 0.15

// front = left of the line, rear = right (hoop_mask.py's FRONT_IS_LEFT) —
// shading the rear side is what makes that polarity visible to the operator
// while placing the split, not just documented in code comments.
const MIN_X = EDGE_SAFE_FRACTION
const MAX_X = 1 - EDGE_SAFE_FRACTION

function clamp(value: number): number {
  return Math.min(MAX_X, Math.max(MIN_X, value))
}

interface HoopSplitEditorProps {
  imageSrc: string
  // Normalized (0-1, fraction of the image's own full width) — the same
  // value persisted in config.hoopSplits and consumed by runner.py.
  splitX: number
  onChange: (splitX: number) => void
}

// Purpose-built single-line editor (Phase 12E) — plain pointer-events, not
// react-konva (AnnotationCanvas's library): one draggable vertical boundary
// on one image is simple enough that a canvas library would be more
// ceremony than the interaction warrants. No zoom/pan — the compare image
// already fits the container at its natural aspect ratio.
export function HoopSplitEditor({ imageSrc, splitX, onChange }: HoopSplitEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragX, setDragX] = useState<number | null>(null)
  const draggingRef = useRef(false)

  const displayX = dragX ?? splitX

  function xFromPointer(clientX: number): number {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return displayX
    return clamp((clientX - rect.left) / rect.width)
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    setDragX(xFromPointer(e.clientX))
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return
    setDragX(xFromPointer(e.clientX))
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return
    draggingRef.current = false
    const finalX = xFromPointer(e.clientX)
    setDragX(null)
    onChange(finalX)
  }

  return (
    <div
      ref={containerRef}
      className={styles.editor}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <img className={styles.image} src={imageSrc} alt="" draggable={false} />
      <div className={styles.rearShade} style={{ left: `${displayX * 100}%` }} />
      <div className={styles.line} style={{ left: `${displayX * 100}%` }} />
      <span className={styles.frontLabel} style={{ right: `${(1 - displayX) * 100}%` }}>Front</span>
      <span className={styles.rearLabel} style={{ left: `${displayX * 100}%` }}>Rear</span>
    </div>
  )
}
