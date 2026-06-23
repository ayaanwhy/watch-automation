import { CANVAS_SIZE } from "./constants.js";
import type { AssemblyLayout, ScaleResult } from "../types/processing.js";

export function createCompressedLayout(scale: ScaleResult): AssemblyLayout {
  const dialWidth = scale.scaledDial.width;
  const remainingWidth = Math.max(0, CANVAS_SIZE - dialWidth);
  const compressedLeftWidth = remainingWidth / 2;
  const compressedRightWidth = remainingWidth / 2;
  const dialLeft = compressedLeftWidth;
  const dialTop = (CANVAS_SIZE - scale.scaledDial.height) / 2;

  return {
    canvasWidth: CANVAS_SIZE,
    canvasHeight: CANVAS_SIZE,
    compressedLeftWidth,
    compressedRightWidth,
    left: {
      left: 0,
      top: dialTop,
      width: compressedLeftWidth,
      height: scale.scaledLeft.height
    },
    dial: {
      left: dialLeft,
      top: dialTop,
      width: dialWidth,
      height: scale.scaledDial.height
    },
    right: {
      left: dialLeft + dialWidth,
      top: dialTop,
      width: compressedRightWidth,
      height: scale.scaledRight.height
    }
  };
}
