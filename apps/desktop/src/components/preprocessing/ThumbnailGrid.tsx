import { useEffect, useRef, useState, type UIEvent } from 'react'
import { ThumbnailCell } from './ThumbnailCell'
import { joinPath, toFileUrl } from '../../lib/paths'
import type { PreprocessingImageState } from '../../context/PreprocessingJobContext'
import styles from './ThumbnailGrid.module.css'

interface ThumbnailGridProps {
  images: PreprocessingImageState[]
  inputDir: string
  selectedImage: string | null
  onSelect: (name: string) => void
}

const CELL_SIZE = 92
const GAP = 8
const BUFFER_ROWS = 3

// Hand-rolled row-windowed virtualization — no thumbnail generation/caching
// (explicit Phase 9 decision: file:// + virtualization + lazy loading first,
// a thumbnailer only if profiling later shows it's needed). Renders every
// image's raw source file directly; only the visible row range (plus a
// buffer) is ever mounted, so a 500–3000 image batch never taxes the DOM.
// Column count and row placement are recomputed from the container's actual
// size via ResizeObserver, mirroring the pattern already established by
// AnnotationCanvas for responsive layout.
export function ThumbnailGrid({ images, inputDir, selectedImage, onSelect }: ThumbnailGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setContainerWidth(rect.width)
      setContainerHeight(rect.height)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const rafRef = useRef<number | null>(null)
  function handleScroll(e: UIEvent<HTMLDivElement>) {
    const top = e.currentTarget.scrollTop
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setScrollTop(top)
    })
  }

  const columns = Math.max(1, Math.floor((containerWidth + GAP) / (CELL_SIZE + GAP)))
  const rowHeight = CELL_SIZE + GAP
  const totalRows = Math.ceil(images.length / columns)
  const totalHeight = totalRows * rowHeight

  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowHeight) - BUFFER_ROWS)
  const lastVisibleRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + containerHeight) / rowHeight) + BUFFER_ROWS
  )
  const startIndex = firstVisibleRow * columns
  const endIndex = Math.min(images.length, lastVisibleRow * columns)
  const visible = images.slice(startIndex, endIndex)

  if (images.length === 0) {
    return (
      <div className={styles.empty}>
        <span>No images in this batch yet.</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={styles.grid} onScroll={handleScroll}>
      <div className={styles.spacer} style={{ height: totalHeight }}>
        {visible.map((img, i) => {
          const index = startIndex + i
          const row = Math.floor(index / columns)
          const col = index % columns
          return (
            <ThumbnailCell
              key={img.name}
              name={img.name}
              status={img.status}
              src={toFileUrl(joinPath(inputDir, img.name))}
              selected={img.name === selectedImage}
              onClick={() => onSelect(img.name)}
              style={{
                top: row * rowHeight,
                left: col * (CELL_SIZE + GAP),
                width: CELL_SIZE,
                height: CELL_SIZE,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
