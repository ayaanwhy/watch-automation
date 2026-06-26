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
  variant: 'splice' | 'scale'
  dragBoundFunc(pos: { x: number; y: number }): { x: number; y: number }
  onDragMove(e: Konva.KonvaEventObject<MouseEvent>): void
  onDragEnd(e: Konva.KonvaEventObject<MouseEvent>): void
  onClickGuide(): void
}

function GuideGroup({ x, height, isActive, variant, dragBoundFunc, onDragMove, onDragEnd, onClickGuide }: GuideGroupProps) {
  const isSplice = variant === 'splice'
  const stroke = isSplice
    ? (isActive ? 'rgba(255,255,255,1.0)' : 'rgba(255,255,255,0.72)')
    : (isActive ? 'rgba(255,102,0,1.0)' : 'rgba(255,102,0,0.72)')
  const shadowColor = isSplice ? 'white' : '#FF6600'
  // Orange is perceptually dimmer than white; boost blur and opacity for scale
  // guides so both variants have comparable visual weight on dark watch images.
  const blur = isSplice
    ? (isActive ? 14 : 6)
    : (isActive ? 20 : 10)
  const opacity = isSplice
    ? (isActive ? 0.95 : 0.55)
    : (isActive ? 1.0 : 0.75)
  const dash = isSplice ? undefined : [10, 6]

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
        shadowColor={shadowColor}
        shadowBlur={blur}
        shadowOpacity={opacity}
        shadowOffsetX={0}
        shadowOffsetY={0}
        dash={dash}
        listening={false}
      />
    </Group>
  )
}

// ── AnnotationCanvas ──────────────────────────────────────────────────────────

export interface AnnotationCanvasHandle {
  getGuides(): {
    spliceLeft: number
    spliceRight: number
    scaleLeft: number | null
    scaleRight: number | null
  } | null
}

interface AnnotationCanvasProps {
  watchKey: string
  filePath: string
  savedSpliceBoundaries: BoundaryData | null
  savedScaleBoundaries: BoundaryData | null
  measureBy: string
  mode: GuideMode
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas(
    { watchKey, filePath, savedSpliceBoundaries, savedScaleBoundaries, measureBy, mode },
    ref
  ) {
    // showScaleGuides is true for Dial watches; comparison is case-insensitive.
    const showScaleGuides = measureBy.toLowerCase() === 'dial'

    const containerRef = useRef<HTMLDivElement>(null)
    const [containerSize, setContainerSize] = useState(0)

    // Splice guide state (replaces old left/right)
    const [spliceLeftPx, setSpliceLeftPxState] = useState<number | null>(null)
    const [spliceRightPx, setSpliceRightPxState] = useState<number | null>(null)
    // Scale guide state (null when not a Dial watch or not yet initialised)
    const [scaleLeftPx, setScaleLeftPxState] = useState<number | null>(null)
    const [scaleRightPx, setScaleRightPxState] = useState<number | null>(null)

    const [activeGuide, setActiveGuide] = useState<'spliceLeft' | 'spliceRight' | 'scaleLeft' | 'scaleRight'>('spliceLeft')

    const { element: imgElement, naturalWidth, naturalHeight, loaded: imgLoaded, error: imgError } =
      useWatchImage(filePath)

    // ── Refs for stable event handlers ───────────────────────────────────────
    const fitRef = useRef<ImageFit | null>(null)
    const spliceLeftPxRef = useRef<number | null>(null)
    const spliceRightPxRef = useRef<number | null>(null)
    const scaleLeftPxRef = useRef<number | null>(null)
    const scaleRightPxRef = useRef<number | null>(null)
    const modeRef = useRef<GuideMode>(mode)
    const naturalWidthRef = useRef(0)
    const activeGuideRef = useRef<'spliceLeft' | 'spliceRight' | 'scaleLeft' | 'scaleRight'>('spliceLeft')
    const showScaleGuidesRef = useRef(showScaleGuides)
    const savedSpliceBoundariesRef = useRef(savedSpliceBoundaries)
    const savedScaleBoundariesRef = useRef(savedScaleBoundaries)

    // Paired setters: update both the ref (synchronously) and the state (async render).
    function setSpliceLeftPx(v: number | null) { spliceLeftPxRef.current = v; setSpliceLeftPxState(v) }
    function setSpliceRightPx(v: number | null) { spliceRightPxRef.current = v; setSpliceRightPxState(v) }
    function setScaleLeftPx(v: number | null) { scaleLeftPxRef.current = v; setScaleLeftPxState(v) }
    function setScaleRightPx(v: number | null) { scaleRightPxRef.current = v; setScaleRightPxState(v) }

    useEffect(() => { modeRef.current = mode }, [mode])
    useEffect(() => { naturalWidthRef.current = naturalWidth }, [naturalWidth])
    useEffect(() => { activeGuideRef.current = activeGuide }, [activeGuide])
    useEffect(() => { showScaleGuidesRef.current = showScaleGuides }, [showScaleGuides])
    useEffect(() => { savedSpliceBoundariesRef.current = savedSpliceBoundaries }, [savedSpliceBoundaries])
    useEffect(() => { savedScaleBoundariesRef.current = savedScaleBoundaries }, [savedScaleBoundaries])

    // ── Reset all guides on watch change ─────────────────────────────────────
    useEffect(() => {
      setSpliceLeftPx(null)
      setSpliceRightPx(null)
      setScaleLeftPx(null)
      setScaleRightPx(null)
      setActiveGuide('spliceLeft')
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

    // ── Initialise splice guides when image is ready ─────────────────────────
    useEffect(() => {
      if (!fit || spliceLeftPx !== null) return
      const saved = savedSpliceBoundariesRef.current
      if (saved) {
        setSpliceLeftPx(saved.leftBoundary)
        setSpliceRightPx(saved.rightBoundary)
      } else {
        setSpliceLeftPx(Math.round(naturalWidth * 0.20))
        setSpliceRightPx(Math.round(naturalWidth * 0.80))
      }
    }, [fit, spliceLeftPx, naturalWidth])

    // ── Initialise scale guides after splice guides are set ──────────────────
    useEffect(() => {
      if (!showScaleGuides || !fit || spliceLeftPx === null || spliceRightPx === null || scaleLeftPx !== null) return
      const saved = savedScaleBoundariesRef.current
      if (saved) {
        setScaleLeftPx(saved.leftBoundary)
        setScaleRightPx(saved.rightBoundary)
      } else {
        const inset = Math.round((spliceRightPx - spliceLeftPx) * 0.15)
        setScaleLeftPx(spliceLeftPx + inset)
        setScaleRightPx(spliceRightPx - inset)
      }
    }, [fit, showScaleGuides, spliceLeftPx, spliceRightPx, scaleLeftPx])

    // ── Expose guide values to parent ─────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      getGuides() {
        if (spliceLeftPxRef.current === null || spliceRightPxRef.current === null) return null
        return {
          spliceLeft: spliceLeftPxRef.current,
          spliceRight: spliceRightPxRef.current,
          scaleLeft: scaleLeftPxRef.current,
          scaleRight: scaleRightPxRef.current,
        }
      },
    }))

    // ── Splice guide drag bound functions ─────────────────────────────────────
    const spliceLeftDragBound = useCallback((pos: { x: number; y: number }) => {
      const f = fitRef.current
      const r = spliceRightPxRef.current
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

    const spliceRightDragBound = useCallback((pos: { x: number; y: number }) => {
      const f = fitRef.current
      const l = spliceLeftPxRef.current
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

    // ── Scale guide drag bound functions ──────────────────────────────────────
    const scaleLeftDragBound = useCallback((pos: { x: number; y: number }) => {
      const f = fitRef.current
      const sL = spliceLeftPxRef.current
      const scR = scaleRightPxRef.current
      if (!f || sL === null || scR === null) return pos
      const minX = toDisplay(sL + MIN_GUIDE_SEPARATION, f)
      const maxX = toDisplay(scR - MIN_GUIDE_SEPARATION, f)
      return { x: Math.max(minX, Math.min(maxX, pos.x)), y: 0 }
    }, [])

    const scaleRightDragBound = useCallback((pos: { x: number; y: number }) => {
      const f = fitRef.current
      const sR = spliceRightPxRef.current
      const scL = scaleLeftPxRef.current
      if (!f || sR === null || scL === null) return pos
      const minX = toDisplay(scL + MIN_GUIDE_SEPARATION, f)
      const maxX = toDisplay(sR - MIN_GUIDE_SEPARATION, f)
      return { x: Math.max(minX, Math.min(maxX, pos.x)), y: 0 }
    }, [])

    // ── Splice left drag ──────────────────────────────────────────────────────
    const handleSpliceLeftDragMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f || naturalWidthRef.current === 0 || modeRef.current !== 'uniform') return
      const newLeft = toOriginal(e.target.x(), f)
      const center = naturalWidthRef.current / 2
      const dist = Math.max(MIN_GUIDE_SEPARATION / 2, center - newLeft)
      setSpliceRightPx(Math.min(naturalWidthRef.current, Math.round(center + dist)))
    }, [])

    const handleSpliceLeftDragEnd = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f || naturalWidthRef.current === 0) return
      let newLeft = Math.round(toOriginal(e.target.x(), f))
      if (modeRef.current === 'uniform') {
        const center = naturalWidthRef.current / 2
        const dist = Math.max(MIN_GUIDE_SEPARATION / 2, center - newLeft)
        newLeft = Math.max(0, Math.round(center - dist))
        setSpliceLeftPx(newLeft)
        setSpliceRightPx(Math.min(naturalWidthRef.current, Math.round(center + dist)))
      } else {
        const r = spliceRightPxRef.current ?? 0
        setSpliceLeftPx(Math.max(0, Math.min(r - MIN_GUIDE_SEPARATION, newLeft)))
      }
      setActiveGuide('spliceLeft')
      clampScaleGuidesIfNeeded()
    }, [])

    // ── Splice right drag ─────────────────────────────────────────────────────
    const handleSpliceRightDragMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f || naturalWidthRef.current === 0 || modeRef.current !== 'uniform') return
      const newRight = toOriginal(e.target.x(), f)
      const center = naturalWidthRef.current / 2
      const dist = Math.max(MIN_GUIDE_SEPARATION / 2, newRight - center)
      setSpliceLeftPx(Math.max(0, Math.round(center - dist)))
    }, [])

    const handleSpliceRightDragEnd = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f || naturalWidthRef.current === 0) return
      let newRight = Math.round(toOriginal(e.target.x(), f))
      if (modeRef.current === 'uniform') {
        const center = naturalWidthRef.current / 2
        const dist = Math.max(MIN_GUIDE_SEPARATION / 2, newRight - center)
        newRight = Math.min(naturalWidthRef.current, Math.round(center + dist))
        setSpliceRightPx(newRight)
        setSpliceLeftPx(Math.max(0, Math.round(center - dist)))
      } else {
        const l = spliceLeftPxRef.current ?? 0
        setSpliceRightPx(Math.min(naturalWidthRef.current, Math.max(l + MIN_GUIDE_SEPARATION, newRight)))
      }
      setActiveGuide('spliceRight')
      clampScaleGuidesIfNeeded()
    }, [])

    // ── Scale guide drags (always free, constrained within splice) ────────────
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const handleScaleLeftDragMove = useCallback((_e: Konva.KonvaEventObject<MouseEvent>) => {
      // Scale guides are always free; no symmetric coupling needed.
    }, [])

    const handleScaleLeftDragEnd = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f) return
      const sL = spliceLeftPxRef.current ?? 0
      const scR = scaleRightPxRef.current ?? naturalWidthRef.current
      const newLeft = Math.round(toOriginal(e.target.x(), f))
      setScaleLeftPx(Math.max(sL + MIN_GUIDE_SEPARATION, Math.min(scR - MIN_GUIDE_SEPARATION, newLeft)))
      setActiveGuide('scaleLeft')
    }, [])

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const handleScaleRightDragMove = useCallback((_e: Konva.KonvaEventObject<MouseEvent>) => {
      // Scale guides are always free; no symmetric coupling needed.
    }, [])

    const handleScaleRightDragEnd = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
      const f = fitRef.current
      if (!f) return
      const sR = spliceRightPxRef.current ?? naturalWidthRef.current
      const scL = scaleLeftPxRef.current ?? 0
      const newRight = Math.round(toOriginal(e.target.x(), f))
      setScaleRightPx(Math.max(scL + MIN_GUIDE_SEPARATION, Math.min(sR - MIN_GUIDE_SEPARATION, newRight)))
      setActiveGuide('scaleRight')
    }, [])

    // ── Clamp scale guides within current splice bounds (called after splice drag) ──
    function clampScaleGuidesIfNeeded() {
      if (!showScaleGuidesRef.current) return
      const sL = spliceLeftPxRef.current ?? 0
      const sR = spliceRightPxRef.current ?? naturalWidthRef.current
      const scL = scaleLeftPxRef.current
      const scR = scaleRightPxRef.current
      if (scL === null || scR === null) return
      const clampedScL = Math.max(sL + MIN_GUIDE_SEPARATION, scL)
      const clampedScR = Math.min(sR - MIN_GUIDE_SEPARATION, scR)
      if (clampedScL < clampedScR - MIN_GUIDE_SEPARATION) {
        setScaleLeftPx(clampedScL)
        setScaleRightPx(clampedScR)
      } else {
        // Splice guides compressed past scale guides: reset scale to centre.
        const mid = Math.round((sL + sR) / 2)
        setScaleLeftPx(mid - MIN_GUIDE_SEPARATION)
        setScaleRightPx(mid + MIN_GUIDE_SEPARATION)
      }
    }

    // ── Keyboard nudging ──────────────────────────────────────────────────────
    function handleKeyDown(e: React.KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()

      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowRight' ? 1 : -1)
      const imgW = naturalWidthRef.current
      const active = activeGuideRef.current

      if (active === 'spliceLeft') {
        const sL = spliceLeftPxRef.current
        const sR = spliceRightPxRef.current
        if (sL === null || sR === null) return
        if (modeRef.current === 'uniform') {
          const center = imgW / 2
          const newL = sL + step
          const dist = center - newL
          if (dist < MIN_GUIDE_SEPARATION / 2) return
          setSpliceLeftPx(Math.max(0, newL))
          setSpliceRightPx(Math.min(imgW, Math.round(center + dist)))
        } else {
          setSpliceLeftPx(Math.max(0, Math.min(sR - MIN_GUIDE_SEPARATION, sL + step)))
        }
        clampScaleGuidesIfNeeded()
      } else if (active === 'spliceRight') {
        const sL = spliceLeftPxRef.current
        const sR = spliceRightPxRef.current
        if (sL === null || sR === null) return
        if (modeRef.current === 'uniform') {
          const center = imgW / 2
          const newR = sR + step
          const dist = newR - center
          if (dist < MIN_GUIDE_SEPARATION / 2) return
          setSpliceRightPx(Math.min(imgW, newR))
          setSpliceLeftPx(Math.max(0, Math.round(center - dist)))
        } else {
          setSpliceRightPx(Math.min(imgW, Math.max(sL + MIN_GUIDE_SEPARATION, sR + step)))
        }
        clampScaleGuidesIfNeeded()
      } else if (active === 'scaleLeft') {
        const sL = spliceLeftPxRef.current ?? 0
        const scL = scaleLeftPxRef.current
        const scR = scaleRightPxRef.current
        if (scL === null || scR === null) return
        setScaleLeftPx(Math.max(sL + MIN_GUIDE_SEPARATION, Math.min(scR - MIN_GUIDE_SEPARATION, scL + step)))
      } else if (active === 'scaleRight') {
        const sR = spliceRightPxRef.current ?? imgW
        const scL = scaleLeftPxRef.current
        const scR = scaleRightPxRef.current
        if (scL === null || scR === null) return
        setScaleRightPx(Math.max(scL + MIN_GUIDE_SEPARATION, Math.min(sR - MIN_GUIDE_SEPARATION, scR + step)))
      }
    }

    // ── Derived display positions ──────────────────────────────────────────────
    const displaySpliceLeft = fit && spliceLeftPx !== null ? toDisplay(spliceLeftPx, fit) : -9999
    const displaySpliceRight = fit && spliceRightPx !== null ? toDisplay(spliceRightPx, fit) : -9999
    const displayScaleLeft = fit && scaleLeftPx !== null ? toDisplay(scaleLeftPx, fit) : -9999
    const displayScaleRight = fit && scaleRightPx !== null ? toDisplay(scaleRightPx, fit) : -9999

    const spliceGuidesReady = fit !== null && spliceLeftPx !== null && spliceRightPx !== null
    const scaleGuidesReady = showScaleGuides && fit !== null && scaleLeftPx !== null && scaleRightPx !== null

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
              {spliceGuidesReady && (
                <>
                  <GuideGroup
                    variant="splice"
                    x={displaySpliceLeft}
                    height={containerSize}
                    isActive={activeGuide === 'spliceLeft'}
                    dragBoundFunc={spliceLeftDragBound}
                    onDragMove={handleSpliceLeftDragMove}
                    onDragEnd={handleSpliceLeftDragEnd}
                    onClickGuide={() => setActiveGuide('spliceLeft')}
                  />
                  <GuideGroup
                    variant="splice"
                    x={displaySpliceRight}
                    height={containerSize}
                    isActive={activeGuide === 'spliceRight'}
                    dragBoundFunc={spliceRightDragBound}
                    onDragMove={handleSpliceRightDragMove}
                    onDragEnd={handleSpliceRightDragEnd}
                    onClickGuide={() => setActiveGuide('spliceRight')}
                  />
                </>
              )}
              {scaleGuidesReady && (
                <>
                  <GuideGroup
                    variant="scale"
                    x={displayScaleLeft}
                    height={containerSize}
                    isActive={activeGuide === 'scaleLeft'}
                    dragBoundFunc={scaleLeftDragBound}
                    onDragMove={handleScaleLeftDragMove}
                    onDragEnd={handleScaleLeftDragEnd}
                    onClickGuide={() => setActiveGuide('scaleLeft')}
                  />
                  <GuideGroup
                    variant="scale"
                    x={displayScaleRight}
                    height={containerSize}
                    isActive={activeGuide === 'scaleRight'}
                    dragBoundFunc={scaleRightDragBound}
                    onDragMove={handleScaleRightDragMove}
                    onDragEnd={handleScaleRightDragEnd}
                    onClickGuide={() => setActiveGuide('scaleRight')}
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
