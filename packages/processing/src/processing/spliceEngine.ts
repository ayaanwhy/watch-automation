import type { SourceImageInfo, SpliceResult } from "../types/processing.js";

export function spliceImage(
  source: SourceImageInfo,
  leftBoundary: number,
  rightBoundary: number
): SpliceResult {
  validateBoundary(source, leftBoundary, "leftBoundary");
  validateBoundary(source, rightBoundary, "rightBoundary");

  if (leftBoundary >= rightBoundary) {
    throw new Error("leftBoundary must be less than rightBoundary");
  }

  return {
    source,
    left: {
      left: 0,
      top: 0,
      width: leftBoundary,
      height: source.height
    },
    dial: {
      left: leftBoundary,
      top: 0,
      width: rightBoundary - leftBoundary,
      height: source.height
    },
    right: {
      left: rightBoundary,
      top: 0,
      width: source.width - rightBoundary,
      height: source.height
    }
  };
}

function validateBoundary(source: SourceImageInfo, value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }

  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer pixel coordinate`);
  }

  if (value < 0 || value > source.width) {
    throw new Error(`${name} must be within the source image width`);
  }
}
