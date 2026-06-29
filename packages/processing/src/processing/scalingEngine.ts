import { PX_PER_MM } from "./constants.js";
import type { ScaleResult, SegmentBox, SpliceResult } from "../types/processing.js";

export function scaleToMeasurement(
  splice: SpliceResult,
  widthMm: number,
  dialWidthOverride?: number
): ScaleResult {
  if (!Number.isFinite(widthMm) || widthMm <= 0) {
    throw new Error("widthMm must be a positive number");
  }

  const effectiveDialWidth = dialWidthOverride ?? splice.dial.width;

  if (effectiveDialWidth <= 0) {
    throw new Error("Dial width must be greater than zero");
  }

  const targetDialWidth = widthMm * PX_PER_MM;
  const scale = targetDialWidth / effectiveDialWidth;

  return {
    targetDialWidth,
    scale,
    scaledSource: {
      width: splice.source.width * scale,
      height: splice.source.height * scale
    },
    scaledLeft: scaleBox(splice.left, scale),
    scaledDial: scaleBox(splice.dial, scale),
    scaledRight: scaleBox(splice.right, scale)
  };
}

function scaleBox(box: SegmentBox, scale: number): SegmentBox {
  return {
    left: box.left * scale,
    top: box.top * scale,
    width: box.width * scale,
    height: box.height * scale
  };
}
