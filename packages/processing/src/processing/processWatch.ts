import sharp from "sharp";
import { spliceImage } from "./spliceEngine.js";
import { scaleToMeasurement } from "./scalingEngine.js";
import { createCompressedLayout } from "./compressionEngine.js";
import { exportAssembly } from "./exportEngine.js";
import type { ProcessWatchInput, ProcessWatchResult } from "../types/processing.js";

export async function processWatch(input: ProcessWatchInput): Promise<ProcessWatchResult> {
  const metadata = await sharp(input.inputPath).metadata();

  if (metadata.format !== "png") {
    throw new Error("Input image must be a PNG");
  }

  if (!metadata.width || !metadata.height) {
    throw new Error("Input PNG must have readable dimensions");
  }

  const source = {
    width: metadata.width,
    height: metadata.height
  };

  const splice = spliceImage(source, input.leftBoundary, input.rightBoundary);
  const scale = scaleToMeasurement(splice, input.widthMm);
  const layout = createCompressedLayout(scale);

  await exportAssembly(input.inputPath, scale, layout, input.outputPath, input.shadow);

  return {
    outputPath: input.outputPath,
    source,
    splice,
    scale,
    layout
  };
}
