import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Group, Image as KonvaImage, Layer, Line, Rect, Stage } from 'react-konva'
import type Konva from 'konva'
import { MIN_GUIDE_SEPARATION } from '../types/annotation'
import type { BoundaryData, GuideMode } from '../types/annotation'
import { useWatchImage } from '../hooks/useWatchImage'
import styles from './AnnotationCanvas.module.css'

// ── Coordinate helpers ────────────────────────────────────────────────────────

interface ImageFit {
  scale: number
  displayW: number
  displayH: number
  offsetX: number
  offsetY: number
}

function computeFit(canvasSize: number, imgW: number, imgH: number): ImageFit {
  const scale = Math.min(canvasSize / imgW, canvasSize / imgH)
  const displayW = imgW * scale
  const displayH = imgH * scale
  return {
    scale,
    displayW,
    displayH,
    offsetX: (canvasSize - displayW) / 2,
    offsetY: (canvasSize - displayH) / 2,
  }
}

function toDisplay(originalX: number, fit: ImageFit): number {
  return fit.offsetX + originalX * fit.scale
}

function toOriginal(displayX: number, fit: ImageFit): number {
  return (displayX - fit.offsetX) / fit.scale
}

// ── GuideGroup ────────────────────────────────────────────────────────────────

interface GuideGroupProps {
  x: number
  height: number
  isActive: boolean
  dragBoundFunc(pos: { x: number; y: number }): { x: number; y: number }
  onDragMove(e: Konva.KonvaEventObject<MouseEvent>): void
  onDragEnd(e: Konva.KonvaEventObject<MouseEvent>): void
  onClickGuide(): void
}

function GuideGroup({ x, height, isActive, dragBoundFunc, onDragMove, onDragEnd, onClickGuide }: GuideGroupProps) {
  const stroke = isActive ? 'rgba(255,255,255,1.0)' : 'rgba(255,255,255,0.72)'
  const blur = isActive ? 14 : 6
  const opacity = isActive ? 0.95 : 0.55

  function handleMouseEnter(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage()
    if (stage) stage.container().style.cursor = 'ew-resize'
  }

  function handleMouseLeave(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage()
    if (stage) stage.container().style.cursor = 'default'
  }

  return (
    <Group
      x={x}
      y={0}
      draggable
      dragBoundFunc={dragBoundFunc}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onClick={onClickGuide}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Wide transparent hit area */}
      <Rect x={-8} y={0} width={16} height={height} fill="transparent" />
      {/* Visible guide line */}
      <Line
        points={[0, 0, 0, height]}
        stroke={stroke}
        strokeWidth={1.5}
        shadowColor="white"
        shadowBlur={blur}
        shadowOpacity={opacity}
        shadowOffsetX={0}
        shadowOffsetY={0}
        listening={false}
      />
    </Group>
  )
}

// ── AnnotationCanvas ──────────────────────────────────────────────────────────

export interface AnnotationCanvasHandle {
  getGuides(): { left: number; right: number } | null
}

interface AnnotationCanvasProps {
  watchKey: string
  filePath: string
  savedBoundaries: BoundaryData | null
  mode: GuideMode
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas({ watchKey, filePath, savedBoundaries, mode }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [containerSize, setContainerSize] = useState(0)

    const [leftPx, setLeftPxState] = useState<number | null>(null)
    const [rightPx, setRightPxState] = useState<number | null>(null)
    const [activeGuide, setActiveGuide] = useState<'left' | 'right'>('left')

    const { element: imgElement, naturalWidth, naturalHeight, loaded: imgLoaded, error: imgError } =
      useWatchImage(filePath)

    // ── Refs for stable event handlers ──────────────────────────────────────
    const fitRef = useRef<ImageFit | null>(null)
    const leftPxRef = useRef<number | null>(null)
    const rightPxRef = useRef<number | null>(null)
    const modeRef = useRef<GuideMode>(mode)
    const naturalWidthRef = useRef(0)
    const activeGuideRef = useRef<'left' | 'right'>('left')
    const savedBoundariesRef = useRef(savedBoundaries)

    function setLeftPx(v: number | null) { leftPxRef.current = v; setLeftPxState(v) }
    function setRightPx(v: number | null) { rightPxRef.current = v; setRightPxState(v) }

    useEffect(() => { modeRef.current = mode }, [mode])
    useEffect(() => { naturalWidthRef.current = naturalWidth }, [naturalWidth])
    useEffect(() => { activeGuideRef.current = activeGuide }, [activeGuide])
    useEffect(() => { savedBoundariesRef.current = savedBoundaries }, [savedBoundaries])

    // ── Reset guides on SKU change ───────────────────────────────────────────
    useEffect(() => {
      setLeftPx(null)
      setRightPx(null)
      setActiveGuide('left')
    }, [watchKey])

    // ── Measure container ────────────────────────────────────────────────────
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      const obs = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect.width
        if (w) setContainerSize(Math.round(w))
      })
      obs.observe(el)
      return () => obs.disconnect()
    }, [])

    // ── Compute fit ──────────────────────────────────────────────────────────
    const fit = useMemo<ImageFit | null>(() => {
      if (!imgLoaded || containerSize === 0 || naturalWidth === 0 || naturalHeight === 0) return null
      return computeFit(containerSize, naturalWidth, naturalHeight)
    }, [imgLoaded, containerSize, naturalWidth, naturalHeight])

    useEffect(() => { fitRef.current = fit }, [fit])

    // ── Initialize guides when image is ready and guides are null ────────────
    useEffect(() => {
      if (!fit || leftPx !== null) return
      const saved = savedBoundariesRef.current
      if (saved) {
        setLeftPx(saved.leftBoundary)
        setRightPx(saved.rightBoundary)
      } else {
        setLeftPx(Math.round(naturalWidth * 0.20))
        setRightPx(Math.round(naturalWidth * 0.80))
      }
    }, [fit, leftPx, naturalWidth])

    // ── Expose guide values to parent ────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      getGuides() {
        if (leftPxRef.current === null || rightPxRef.current === null) return null
        return { left: leftPxRef.current, right: rightPxRef.current }
      },
    }))

    // ── Drag constraint functions (stable, read from refs) ───────────────────
    const leftDragBound = useCallback((pos: { x: number; y: number }) => {
      const f = fitRef.current
      const r = rightPxRef.current
      if (!f || r === null || naturalWidthRef.current === 0) return pos
      const minX = f.offsetX
      let maxX: number
      if (modeRef.current === 'uniform') {
        const center = f.offsetX + (naturalWidthRef.current / 2) * f.scale
        maxX = center - (MIN_GUIDE_SEPARATION / 2) * f.scale
      } else {
        maxX = toDisplay(r - MIN_GUIDE_SEPARATION, f)
      }
      return { x: Math.max(minX, Math.min(maxX, pos.x)), y: 0 }
    }, [])

    const rightDragBound = useCallback((pos: { x: number; y: number }) => {
      const f = fitRef.current
      const l = leftPxRef.current
      if (!f || l === null || naturalWidthRef.current === 0) return pos
      const maxX = f.offsetX + f.displayW
      let minX: number
      if (modeRef.current === 'uniform') {
        const center = f.offsetX + (naturalWidthRef.current / 2) * f.scale
        minX = center + (MIN_GUIDE_SEPARATION / 2) * f.scale
      } else {
        minX = toDisplay(l + MIN_GUIDE_SEPARATION, f)
      }
      return { x: Math.max(minX, Math.min(maxX, pos.x)), y: 0 }
    }, [])

    // ── Left guide drag ──────────────────────────────────────────────────────
    const handleLeftDragMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f || naturalWidthRef.current === 0 || modeRef.current !== 'uniform') return
      const newLeft = toOriginal(e.target.x(), f)
      const center = naturalWidthRef.current / 2
      const dist = Math.max(MIN_GUIDE_SEPARATION / 2, center - newLeft)
      setRightPx(Math.min(naturalWidthRef.current, Math.round(center + dist)))
    }, [])

    const handleLeftDragEnd = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f || naturalWidthRef.current === 0) return
      let newLeft = Math.round(toOriginal(e.target.x(), f))
      if (modeRef.current === 'uniform') {
        const center = naturalWidthRef.current / 2
        const dist = Math.max(MIN_GUIDE_SEPARATION / 2, center - newLeft)
        newLeft = Math.max(0, Math.round(center - dist))
        setLeftPx(newLeft)
        setRightPx(Math.min(naturalWidthRef.current, Math.round(center + dist)))
      } else {
        const r = rightPxRef.current ?? 0
        setLeftPx(Math.max(0, Math.min(r - MIN_GUIDE_SEPARATION, newLeft)))
      }
      setActiveGuide('left')
    }, [])

    // ── Right guide drag ─────────────────────────────────────────────────────
    const handleRightDragMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f || naturalWidthRef.current === 0 || modeRef.current !== 'uniform') return
      const newRight = toOriginal(e.target.x(), f)
      const center = naturalWidthRef.current / 2
      const dist = Math.max(MIN_GUIDE_SEPARATION / 2, newRight - center)
      setLeftPx(Math.max(0, Math.round(center - dist)))
    }, [])

    const handleRightDragEnd = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f || naturalWidthRef.current === 0) return
      let newRight = Math.round(toOriginal(e.target.x(), f))
      if (modeRef.current === 'uniform') {
        const center = naturalWidthRef.current / 2
        const dist = Math.max(MIN_GUIDE_SEPARATION / 2, newRight - center)
        newRight = Math.min(naturalWidthRef.current, Math.round(center + dist))
        setRightPx(newRight)
        setLeftPx(Math.max(0, Math.round(center - dist)))
      } else {
        const l = leftPxRef.current ?? 0
        setRightPx(Math.min(naturalWidthRef.current, Math.max(l + MIN_GUIDE_SEPARATION, newRight)))
      }
      setActiveGuide('right')
    }, [])

    // ── Keyboard nudging ─────────────────────────────────────────────────────
    function handleKeyDown(e: React.KeyboardEvent) {
      if (!fitRef.current || leftPxRef.current === null || rightPxRef.current === null) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()

      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowRight' ? 1 : -1)
      const imgW = naturalWidthRef.current
      const L = leftPxRef.current
      const R = rightPxRef.current

      if (activeGuideRef.current === 'left') {
        if (modeRef.current === 'uniform') {
          const center = imgW / 2
          const newL = L + step
          const dist = center - newL
          if (dist < MIN_GUIDE_SEPARATION / 2) return
          setLeftPx(Math.max(0, newL))
          setRightPx(Math.min(imgW, Math.round(center + dist)))
        } else {
          setLeftPx(Math.max(0, Math.min(R - MIN_GUIDE_SEPARATION, L + step)))
        }
      } else {
        if (modeRef.current === 'uniform') {
          const center = imgW / 2
          const newR = R + step
          const dist = newR - center
          if (dist < MIN_GUIDE_SEPARATION / 2) return
          setRightPx(Math.min(imgW, newR))
          setLeftPx(Math.max(0, Math.round(center - dist)))
        } else {
          setRightPx(Math.min(imgW, Math.max(L + MIN_GUIDE_SEPARATION, R + step)))
        }
      }
    }

    // ── Derived display positions ────────────────────────────────────────────
    const displayLeft = fit && leftPx !== null ? toDisplay(leftPx, fit) : -9999
    const displayRight = fit && rightPx !== null ? toDisplay(rightPx, fit) : -9999
    const guidesReady = fit !== null && leftPx !== null && rightPx !== null

    return (
      <div
        ref={containerRef}
        className={styles.container}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        aria-label="Annotation canvas"
      >
        {containerSize > 0 && (
          <Stage width={containerSize} height={containerSize}>
            <Layer>
              {imgLoaded && imgElement && fit && (
                <KonvaImage
                  image={imgElement}
                  x={fit.offsetX}
                  y={fit.offsetY}
                  width={fit.displayW}
                  height={fit.displayH}
                  listening={false}
                />
              )}
            </Layer>
            <Layer>
              {guidesReady && (
                <>
                  <GuideGroup
                    x={displayLeft}
                    height={containerSize}
                    isActive={activeGuide === 'left'}
                    dragBoundFunc={leftDragBound}
                    onDragMove={handleLeftDragMove}
                    onDragEnd={handleLeftDragEnd}
                    onClickGuide={() => setActiveGuide('left')}
                  />
                  <GuideGroup
                    x={displayRight}
                    height={containerSize}
                    isActive={activeGuide === 'right'}
                    dragBoundFunc={rightDragBound}
                    onDragMove={handleRightDragMove}
                    onDragEnd={handleRightDragEnd}
                    onClickGuide={() => setActiveGuide('right')}
                  />
                </>
              )}
            </Layer>
          </Stage>
        )}

        {!imgLoaded && !imgError && (
          <div className={styles.overlay}>
            <span className={styles.loadingText}>Loading…</span>
          </div>
        )}
        {imgError && (
          <div className={styles.overlay}>
            <span className={styles.errorText}>Failed to load image</span>
          </div>
        )}
      </div>
    )
  }
)
