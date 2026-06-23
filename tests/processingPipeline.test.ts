import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  CANVAS_SIZE,
  PX_PER_MM,
  createCompressedLayout,
  createDropShadow,
  defaultShadowSettings,
  processWatch,
  scaleToMeasurement,
  spliceImage
} from "../packages/processing/src/index.js";

const tmpDir = join(process.cwd(), ".tmp-tests");

describe("phase 0 processing pipeline", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("splices, scales, centers, compresses, and exports a vertically trimmed PNG", async () => {
    const inputPath = join(tmpDir, "synthetic-watch.png");
    const outputPath = join(tmpDir, "WT001;frontImage.png");

    await createSyntheticWatch(inputPath);

    const result = await processWatch({
      inputPath,
      outputPath,
      widthMm: 44,
      leftBoundary: 200,
      rightBoundary: 600,
      shadow: {
        opacity: 0
      }
    });

    const output = await sharp(outputPath).metadata();

    expect(output.format).toBe("png");
    expect(output.width).toBe(CANVAS_SIZE);
    expect(output.height).toBe(1600);
    expect(result.splice.left.width).toBe(200);
    expect(result.splice.dial.width).toBe(400);
    expect(result.splice.right.width).toBe(400);
    expect(result.scale.targetDialWidth).toBeCloseTo(44 * PX_PER_MM, 5);
    expect(result.scale.scale).toBeCloseTo(4, 5);
    expect(result.layout.dial.left).toBeCloseTo(200, 5);
    expect(result.layout.dial.width).toBeCloseTo(1600, 5);
    expect(result.layout.dial.top).toBeCloseTo(200, 5);
    expect(result.layout.left.left).toBe(0);
    expect(result.layout.left.width).toBeCloseTo(200, 5);
    expect(result.layout.right.left).toBeCloseTo(1800, 5);
    expect(result.layout.right.width).toBeCloseTo(200, 5);
    expect(result.layout.right.left + result.layout.right.width).toBeCloseTo(2000, 5);
  });

  it("allows near-zero strap compression when the dial nearly fills the canvas", () => {
    const splice = spliceImage({ width: 1000, height: 400 }, 250, 750);
    const scale = scaleToMeasurement(splice, 54.99);
    const layout = createCompressedLayout(scale);

    expect(layout.dial.width).toBeCloseTo(1999.636363, 5);
    expect(layout.left.width).toBeGreaterThan(0);
    expect(layout.left.width).toBeLessThan(1);
    expect(layout.right.left + layout.right.width).toBeCloseTo(2000, 5);
  });

  it("clips oversized centered segments to the 2000px canvas", async () => {
    const inputPath = join(tmpDir, "tall-watch.png");
    const outputPath = join(tmpDir, "WT002;frontImage.png");

    await createSyntheticWatch(inputPath, 800);

    const result = await processWatch({
      inputPath,
      outputPath,
      widthMm: 44,
      leftBoundary: 200,
      rightBoundary: 600,
      shadow: {
        opacity: 0
      }
    });

    const output = await sharp(outputPath).metadata();

    expect(output.width).toBe(CANVAS_SIZE);
    expect(output.height).toBe(CANVAS_SIZE);
    expect(result.layout.dial.height).toBeCloseTo(3200, 5);
    expect(result.layout.dial.top).toBeCloseTo(-600, 5);
  });

  it("builds shadow from watch alpha only, then tints, offsets, and masks it", async () => {
    const assembled = await sharp({
      create: {
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: CANVAS_SIZE,
              height: 80,
              channels: 4,
              background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 900
        }
      ])
      .png()
      .toBuffer();

    const shadow = await createDropShadow(assembled, defaultShadowSettings);
    const raw = await sharp(shadow).raw().toBuffer();
    const leftMaskedAlpha = pixel(raw, 100, 954).a;
    const centerPixel = pixel(raw, 1000, 954);
    const sourceRowPixel = pixel(raw, 1000, 900);

    expect(leftMaskedAlpha).toBe(0);
    expect(centerPixel.r).toBe(0x2e);
    expect(centerPixel.g).toBe(0x17);
    expect(centerPixel.b).toBe(0x0a);
    expect(centerPixel.a).toBeGreaterThan(0);
    expect(centerPixel.a).toBeLessThanOrEqual(Math.round(255 * defaultShadowSettings.opacity));
    expect(sourceRowPixel.a).toBeLessThan(centerPixel.a);
  });
});

function pixel(
  raw: Buffer,
  x: number,
  y: number
): { r: number; g: number; b: number; a: number } {
  const index = (y * CANVAS_SIZE + x) * 4;

  return {
    r: raw[index],
    g: raw[index + 1],
    b: raw[index + 2],
    a: raw[index + 3]
  };
}

async function createSyntheticWatch(outputPath: string, height = 400): Promise<void> {
  const leftStrap = await sharp({
    create: {
      width: 200,
      height,
      channels: 4,
      background: { r: 180, g: 20, b: 20, alpha: 1 }
    }
  })
    .png()
    .toBuffer();

  const dial = await sharp({
    create: {
      width: 400,
      height,
      channels: 4,
      background: { r: 20, g: 180, b: 20, alpha: 1 }
    }
  })
    .png()
    .toBuffer();

  const rightStrap = await sharp({
    create: {
      width: 400,
      height,
      channels: 4,
      background: { r: 20, g: 20, b: 180, alpha: 1 }
    }
  })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: 1000,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      { input: leftStrap, left: 0, top: 0 },
      { input: dial, left: 200, top: 0 },
      { input: rightStrap, left: 600, top: 0 }
    ])
    .png()
    .toFile(outputPath);
}
