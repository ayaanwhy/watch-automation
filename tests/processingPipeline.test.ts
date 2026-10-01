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

  // 2026-09-30 regression — a real, reproduced gap between the dial and the
  // right strap in Watch output (left/dial always connects correctly; only
  // dial/right could gap). Root cause: layout.right.left was
  // `dialLeft + dialWidth` rounded as one exact sum, while the dial's OWN
  // on-canvas geometry is `Math.round(dialLeft)` positioned with a
  // `Math.round(dialWidth)`-wide rendered buffer — Math.round(a)+Math.round(b)
  // is not always Math.round(a+b). widthMm 20.0 with this splice reproduces
  // it precisely: dialLeft≈636.364, dialWidth≈727.273 round to 636/727 (dial
  // visually occupies columns [636, 1363)), while the OLD right.left rounded
  // to 1364 — leaving column 1363 fully transparent. Fixed in
  // exportEngine.ts by deriving the right segment's position from the
  // dial's own already-rounded left+width instead of re-rounding the exact
  // sum independently (mirroring how the left/dial boundary was already
  // gap-free, by reusing one shared expression for both sides of it).
  it("never leaves a transparent column between the dial and the right strap, at a width that reproduces the gap", async () => {
    const inputPath = join(tmpDir, "gap-watch.png");
    const outputPath = join(tmpDir, "WT003;frontImage.png");

    await createSyntheticWatch(inputPath);

    const result = await processWatch({
      inputPath,
      outputPath,
      widthMm: 20.0,
      leftBoundary: 200,
      rightBoundary: 600,
      shadow: { opacity: 0 }
    });

    // The exact fractional values that reproduce the bug (documented above) —
    // if compressionEngine.ts's math ever changes, this pins down that the
    // regression case is still actually being exercised, not silently
    // testing a now-integer, gap-safe combination instead.
    expect(result.layout.dial.left).toBeCloseTo(636.3636363636363, 5);
    expect(result.layout.dial.width).toBeCloseTo(727.2727272727274, 5);

    const dialVisualEnd = Math.round(result.layout.dial.left) + Math.round(result.layout.dial.width);
    expect(dialVisualEnd).toBe(1363);

    const raw = await sharp(outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const midRow = Math.floor(raw.info.height / 2);

    // The dial's last real column and the right strap's first real column
    // must be OPAQUE and adjacent — no transparent seam between them.
    const dialLastColumn = pixel2(raw.data, raw.info.width, dialVisualEnd - 1, midRow);
    const rightFirstColumn = pixel2(raw.data, raw.info.width, dialVisualEnd, midRow);
    expect(dialLastColumn.a, "dial's last column must be opaque").toBeGreaterThan(0);
    expect(rightFirstColumn.a, "the column immediately after the dial must already be the opaque right strap — no transparent gap column").toBeGreaterThan(0);
    // It's genuinely the right (blue) strap, not a stray dial (green) pixel.
    expect(rightFirstColumn.b).toBeGreaterThan(rightFirstColumn.g);

    // General sweep: no fully-transparent column anywhere strictly between
    // the dial's start and the canvas's right-hand content — catches a gap
    // wherever it would fall, independent of the exact pixel math above.
    const dialStart = Math.round(result.layout.dial.left);
    let rightContentEnd = raw.info.width;
    for (let x = raw.info.width - 1; x >= dialStart; x -= 1) {
      if (pixel2(raw.data, raw.info.width, x, midRow).a > 0) {
        rightContentEnd = x + 1;
        break;
      }
    }
    const transparentColumns: number[] = [];
    for (let x = dialStart; x < rightContentEnd; x += 1) {
      if (pixel2(raw.data, raw.info.width, x, midRow).a === 0) transparentColumns.push(x);
    }
    expect(transparentColumns, `transparent gap column(s) found: ${transparentColumns.join(", ")}`).toEqual([]);
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

function pixel2(
  raw: Buffer,
  width: number,
  x: number,
  y: number
): { r: number; g: number; b: number; a: number } {
  const index = (y * width + x) * 4;

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
