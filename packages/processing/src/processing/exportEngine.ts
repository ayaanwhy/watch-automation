import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { CANVAS_SIZE } from "./constants.js";
import { createDropShadow, defaultShadowSettings } from "./shadowEngine.js";
import type { AssemblyLayout, ScaleResult, ShadowSettings } from "../types/processing.js";

export async function exportAssembly(
  inputPath: string,
  scale: ScaleResult,
  layout: AssemblyLayout,
  outputPath: string,
  shadowSettings?: Partial<ShadowSettings>
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  const left = await renderSegment(inputPath, {
    sourceLeft: 0,
    sourceWidth: scale.scaledLeft.width / scale.scale,
    resizeWidth: layout.left.width,
    resizeHeight: layout.left.height
  });

  const dial = await renderSegment(inputPath, {
    sourceLeft: scale.scaledDial.left / scale.scale,
    sourceWidth: scale.scaledDial.width / scale.scale,
    resizeWidth: layout.dial.width,
    resizeHeight: layout.dial.height
  });

  const right = await renderSegment(inputPath, {
    sourceLeft: scale.scaledRight.left / scale.scale,
    sourceWidth: scale.scaledRight.width / scale.scale,
    resizeWidth: layout.right.width,
    resizeHeight: layout.right.height
  });

  const base = sharp({
    create: {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  });

  const composites = (
    await Promise.all([
      createCanvasOverlay(left, layout.left.left, layout.left.top),
      createCanvasOverlay(dial, layout.dial.left, layout.dial.top),
      createCanvasOverlay(right, layout.right.left, layout.right.top)
    ])
  ).filter((item): item is sharp.OverlayOptions => item !== null);

  const assembled = await base.composite(composites).png().toBuffer();
  const shadow = await createDropShadow(assembled, {
    ...defaultShadowSettings,
    ...shadowSettings
  });

  const finalImage = await sharp({
    create: {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: assembled, left: 0, top: 0 }
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const trimmedImage = await trimTransparentTopBottom(finalImage);

  await sharp(trimmedImage)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
}

interface RenderSegmentInput {
  sourceLeft: number;
  sourceWidth: number;
  resizeWidth: number;
  resizeHeight: number;
}

async function renderSegment(inputPath: string, input: RenderSegmentInput): Promise<Buffer> {
  const sourceWidth = Math.round(input.sourceWidth);
  const resizeWidth = Math.round(input.resizeWidth);
  const resizeHeight = Math.round(input.resizeHeight);

  if (sourceWidth <= 0 || resizeWidth <= 0 || resizeHeight <= 0) {
    return Buffer.alloc(0);
  }

  const metadata = await sharp(inputPath).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Input image must have readable dimensions");
  }

  return sharp(inputPath)
    .extract({
      left: Math.round(input.sourceLeft),
      top: 0,
      width: sourceWidth,
      height: metadata.height
    })
    .resize({
      width: resizeWidth,
      height: resizeHeight,
      fit: "fill"
    })
    .png()
    .toBuffer();
}

async function createCanvasOverlay(
  input: Buffer,
  left: number,
  top: number
): Promise<sharp.OverlayOptions | null> {
  if (input.length === 0) {
    return null;
  }

  const roundedLeft = Math.round(left);
  const roundedTop = Math.round(top);
  const metadata = await sharp(input).metadata();

  if (!metadata.width || !metadata.height) {
    return null;
  }

  const cropLeft = Math.max(0, -roundedLeft);
  const cropTop = Math.max(0, -roundedTop);
  const overlayLeft = Math.max(0, roundedLeft);
  const overlayTop = Math.max(0, roundedTop);
  const visibleWidth = Math.min(metadata.width - cropLeft, CANVAS_SIZE - overlayLeft);
  const visibleHeight = Math.min(metadata.height - cropTop, CANVAS_SIZE - overlayTop);

  if (visibleWidth <= 0 || visibleHeight <= 0) {
    return null;
  }

  const croppedInput = await sharp(input)
    .extract({
      left: cropLeft,
      top: cropTop,
      width: visibleWidth,
      height: visibleHeight
    })
    .png()
    .toBuffer();

  return {
    input: croppedInput,
    left: overlayLeft,
    top: overlayTop
  };
}

async function trimTransparentTopBottom(input: Buffer): Promise<Buffer> {
  const image = sharp(input).ensureAlpha();
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    return input;
  }

  const alpha = await sharp(input).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  let top = -1;
  let bottom = -1;

  for (let y = 0; y < metadata.height; y += 1) {
    if (rowHasAlpha(alpha, metadata.width, y)) {
      top = y;
      break;
    }
  }

  for (let y = metadata.height - 1; y >= 0; y -= 1) {
    if (rowHasAlpha(alpha, metadata.width, y)) {
      bottom = y;
      break;
    }
  }

  if (top < 0 || bottom < 0) {
    return input;
  }

  return sharp(input)
    .extract({
      left: 0,
      top,
      width: metadata.width,
      height: bottom - top + 1
    })
    .png()
    .toBuffer();
}

function rowHasAlpha(alpha: Buffer, width: number, y: number): boolean {
  const rowStart = y * width;
  const rowEnd = rowStart + width;

  for (let index = rowStart; index < rowEnd; index += 1) {
    if (alpha[index] > 0) {
      return true;
    }
  }

  return false;
}
