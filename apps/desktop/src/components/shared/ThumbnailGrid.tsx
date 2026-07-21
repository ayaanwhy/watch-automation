import { useEffect, useRef, useState, type UIEvent } from 'react'
import { ThumbnailCell, type ThumbnailStatus } from './ThumbnailCell'
import { joinPath, toFileUrl } from '../../lib/paths'
import styles from './ThumbnailGrid.module.css'

// The minimal shape this component actually needs — name and status are the
// only fields ever read (src is computed here from inputDir + name). Any
// job's image-state type structurally satisfies this without importing it,
// so the same grid serves Preprocessing's and Ring & Bracelet's contexts.
export interface ThumbnailGridImage {
  name: string
  status: ThumbnailStatus
  // Surfaces an already-existing per-image review flag (Phase 10F) — e.g.
  // Ring & Bracelet's shank-mask detected===false — as a generic grid badge.
  // Not a new signal: callers derive this from whatever confidence/review
  // state their own stage already tracks; stages with no such concept (Watch,
  // Preprocessing) simply never set it.
  lowConfidence?: boolean
}

// Fullscreen review (Phase 10F) prev/next navigation — every ThumbnailGrid
// caller already owns both the ordered image array and the current
// selection (that's exactly what's passed in as props here), so computing
// "the next/previous name" from that same state is all a fullscreen viewer
// needs; no separate index state was introduced anywhere for this.
export function findAdjacentImage(
  images: { name: string }[],
  currentName: string | null,
  direction: 1 | -1
): string | null {
  if (images.length === 0) return null
  const index = currentName ? images.findIndex(img => img.name === currentName) : -1
  if (index === -1) return images[0].name
  const nextIndex = index + direction
  if (nextIndex < 0 || nextIndex >= images.length) return null
  return images[nextIndex].name
}

interface ThumbnailGridProps {
  images: ThumbnailGridImage[]
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
              lowConfidence={img.lowConfidence}
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
