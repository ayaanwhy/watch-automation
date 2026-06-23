import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { CANVAS_SIZE, processWatch } from "../packages/processing/src/index.js";

const tmpDir = join(process.cwd(), ".tmp-known-good-tests");

interface KnownGoodCase {
  name: string;
  inputPath: string;
  widthMm: number;
  leftBoundary: number;
  rightBoundary: number;
  expected: {
    sourceWidth: number;
    sourceHeight: number;
    dialWidth: number;
    scale: number;
    outputWidth: number;
    outputHeight: number;
    dialLeft: number;
    dialTop: number;
    compressedStrapWidth: number;
  };
}

describe("known-good processing fixtures", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await createKnownGoodFixtures();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it.each(getKnownGoodCases())("processes $name without changing production behavior", async (testCase) => {
    if (!existsSync(testCase.inputPath)) {
      throw new Error(`Missing fixture: ${testCase.inputPath}`);
    }

    const outputPath = join(tmpDir, `${testCase.name};frontImage.png`);
    const result = await processWatch({
      inputPath: testCase.inputPath,
      outputPath,
      widthMm: testCase.widthMm,
      leftBoundary: testCase.leftBoundary,
      rightBoundary: testCase.rightBoundary
    });
    const output = await sharp(outputPath).metadata();

    expect(result.source.width).toBe(testCase.expected.sourceWidth);
    expect(result.source.height).toBe(testCase.expected.sourceHeight);
    expect(result.splice.dial.width).toBe(testCase.expected.dialWidth);
    expect(result.scale.scale).toBeCloseTo(testCase.expected.scale, 5);
    expect(result.layout.dial.left).toBeCloseTo(testCase.expected.dialLeft, 5);
    expect(result.layout.dial.top).toBeCloseTo(testCase.expected.dialTop, 5);
    expect(result.layout.left.width).toBeCloseTo(testCase.expected.compressedStrapWidth, 5);
    expect(result.layout.right.width).toBeCloseTo(testCase.expected.compressedStrapWidth, 5);
    expect(output.format).toBe("png");
    expect(output.width).toBe(testCase.expected.outputWidth);
    expect(output.height).toBe(testCase.expected.outputHeight);
    expect(output.channels).toBe(4);
    expect(output.hasAlpha).toBe(true);
  });
});

function getKnownGoodCases(): KnownGoodCase[] {
  return [
    {
      name: "TH1710451W-real-sample",
      inputPath: join(process.cwd(), "sampledata", "TH1710451W.png"),
      widthMm: 44,
      leftBoundary: 390,
      rightBoundary: 3005,
      expected: {
        sourceWidth: 3799,
        sourceHeight: 2421,
        dialWidth: 2615,
        scale: 0.6118546845124284,
        outputWidth: CANVAS_SIZE,
        outputHeight: 1564,
        dialLeft: 199.9999999999999,
        dialTop: 259.34990439770536,
        compressedStrapWidth: 199.9999999999999
      }
    },
    {
      name: "fixture-balanced-44mm",
      inputPath: join(tmpDir, "fixture-balanced-44mm.png"),
      widthMm: 44,
      leftBoundary: 300,
      rightBoundary: 1100,
      expected: {
        sourceWidth: 1400,
        sourceHeight: 700,
        dialWidth: 800,
        scale: 2,
        outputWidth: CANVAS_SIZE,
        outputHeight: 1484,
        dialLeft: 199.9999999999999,
        dialTop: 300,
        compressedStrapWidth: 199.9999999999999
      }
    },
    {
      name: "fixture-wide-dial-40mm",
      inputPath: join(tmpDir, "fixture-wide-dial-40mm.png"),
      widthMm: 40,
      leftBoundary: 240,
      rightBoundary: 1200,
      expected: {
        sourceWidth: 1680,
        sourceHeight: 640,
        dialWidth: 960,
        scale: 1.5151515151515151,
        outputWidth: CANVAS_SIZE,
        outputHeight: 1054,
        dialLeft: 272.72727272727275,
        dialTop: 515.1515151515151,
        compressedStrapWidth: 272.72727272727275
      }
    }
  ];
}

async function createKnownGoodFixtures(): Promise<void> {
  await createSolidWatch(join(tmpDir, "fixture-balanced-44mm.png"), {
    leftWidth: 300,
    dialWidth: 800,
    rightWidth: 300,
    height: 700
  });
  await createSolidWatch(join(tmpDir, "fixture-wide-dial-40mm.png"), {
    leftWidth: 240,
    dialWidth: 960,
    rightWidth: 480,
    height: 640
  });
}

async function createSolidWatch(
  outputPath: string,
  dimensions: { leftWidth: number; dialWidth: number; rightWidth: number; height: number }
): Promise<void> {
  const { leftWidth, dialWidth, rightWidth, height } = dimensions;
  const left = await solidSegment(leftWidth, height, { r: 120, g: 40, b: 40, alpha: 1 });
  const dial = await solidSegment(dialWidth, height, { r: 40, g: 120, b: 40, alpha: 1 });
  const right = await solidSegment(rightWidth, height, { r: 40, g: 40, b: 120, alpha: 1 });

  await sharp({
    create: {
      width: leftWidth + dialWidth + rightWidth,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: dial, left: leftWidth, top: 0 },
      { input: right, left: leftWidth + dialWidth, top: 0 }
    ])
    .png()
    .toFile(outputPath);
}

async function solidSegment(
  width: number,
  height: number,
  background: { r: number; g: number; b: number; alpha: number }
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background
    }
  })
    .png()
    .toBuffer();
}
