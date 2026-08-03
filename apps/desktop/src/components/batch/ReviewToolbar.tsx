import { ZoomIn, ZoomOut } from 'lucide-react'
import { SegmentedControl } from '../ui/SegmentedControl'
import type { ComparisonBackground, CompareMode } from '../shared/BeforeAfterSlider'
import styles from './ReviewToolbar.module.css'

const BACKGROUND_OPTIONS: { value: ComparisonBackground; label: string }[] = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'white', label: 'White' },
  { value: 'checkerboard', label: 'Checkerboard' },
]

const COMPARE_MODE_OPTIONS: { value: CompareMode; label: string }[] = [
  { value: 'slider', label: 'Slider' },
  { value: 'sideBySide', label: 'Side by Side' },
]

const ZOOM_LEVELS = [1, 1.5, 2]

interface ReviewToolbarProps {
  background: ComparisonBackground
  onBackgroundChange: (background: ComparisonBackground) => void
  compareMode: CompareMode
  onCompareModeChange: (mode: CompareMode) => void
  zoom: number
  onZoomChange: (zoom: number) => void
}

// Batch Details' Images section review toolbar (Phase 13G, Screen-by-Screen
// Direction: "a review toolbar — backdrop toggle (B), compare mode, zoom").
// Rendered once, above the grid/preview split, and controls whichever
// preview panel is currently mounted (embedded or fullscreen) via the
// controlled background/compareMode/zoom props BeforeAfterSlider and its two
// callers gained this phase — so the same choice holds regardless of which
// image is selected or whether the viewer is fullscreen. The backdrop
// toggle's keyboard 'B' shortcut is unaffected by living here instead of
// inline — useBackdropCycle (13F) already calls whichever onBackgroundChange
// it's given, controlled or not.
export function ReviewToolbar({
  background,
  onBackgroundChange,
  compareMode,
  onCompareModeChange,
  zoom,
  onZoomChange,
}: ReviewToolbarProps) {
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom)

  function stepZoom(delta: number) {
    const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIndex + delta))
    onZoomChange(ZOOM_LEVELS[next])
  }

  return (
    <div className={styles.toolbar}>
      <SegmentedControl
        variant="pill"
        options={BACKGROUND_OPTIONS}
        value={background}
        onChange={onBackgroundChange}
        aria-label="Backdrop"
      />
      <SegmentedControl
        variant="pill"
        options={COMPARE_MODE_OPTIONS}
        value={compareMode}
        onChange={onCompareModeChange}
        aria-label="Compare mode"
      />
      <div className={styles.zoomControl}>
        <button
          type="button"
          className={styles.zoomButton}
          onClick={() => stepZoom(-1)}
          disabled={zoomIndex <= 0}
          aria-label="Zoom out"
        >
          <ZoomOut size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <span className={`${styles.zoomLabel} tabular-nums`}>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className={styles.zoomButton}
          onClick={() => stepZoom(1)}
          disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
          aria-label="Zoom in"
        >
          <ZoomIn size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
