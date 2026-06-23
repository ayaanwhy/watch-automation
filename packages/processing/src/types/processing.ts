export type BoundarySource = "manual" | "ai" | "ai-reviewed";

export interface BoundaryData {
  sku?: string;
  leftBoundary: number;
  rightBoundary: number;
  boundarySource?: BoundarySource;
}

export interface ProcessWatchInput {
  inputPath: string;
  outputPath: string;
  widthMm: number;
  leftBoundary: number;
  rightBoundary: number;
  shadow?: Partial<ShadowSettings>;
}

export interface ShadowSettings {
  xOffset: number;
  yOffset: number;
  blurRadius: number;
  spread: number;
  density: number;
  opacity: number;
  color: string;
}

export interface SourceImageInfo {
  width: number;
  height: number;
}

export interface SpliceResult {
  source: SourceImageInfo;
  left: SegmentBox;
  dial: SegmentBox;
  right: SegmentBox;
}

export interface SegmentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScaleResult {
  targetDialWidth: number;
  scale: number;
  scaledSource: SourceImageInfo;
  scaledLeft: SegmentBox;
  scaledDial: SegmentBox;
  scaledRight: SegmentBox;
}

export interface AssemblyLayout {
  canvasWidth: number;
  canvasHeight: number;
  dial: SegmentBox;
  left: SegmentBox;
  right: SegmentBox;
  compressedLeftWidth: number;
  compressedRightWidth: number;
}

export interface ProcessWatchResult {
  outputPath: string;
  source: SourceImageInfo;
  splice: SpliceResult;
  scale: ScaleResult;
  layout: AssemblyLayout;
}
