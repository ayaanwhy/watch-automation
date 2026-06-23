import sharp from "sharp";
import { CANVAS_SIZE } from "./constants.js";
import type { ShadowSettings } from "../types/processing.js";

export const defaultShadowSettings: ShadowSettings = {
  xOffset: 0,
  yOffset: 54,
  blurRadius: 16,
  spread: 0,
  density: 1.75,
  opacity: 0.3,
  color: "#2e170a"
};

export async function createDropShadow(
  assembledPng: Buffer,
  settings: ShadowSettings = defaultShadowSettings
): Promise<Buffer> {
  const alpha = await sharp(assembledPng)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer();

  const color = parseHexColor(settings.color);
  const thresholdMask = thresholdAlpha(alpha);
  const denseMask = applyShadowDensity(thresholdMask, settings.density);
  const spreadMask = settings.spread > 0
    ? dilateAlpha(denseMask, CANVAS_SIZE, CANVAS_SIZE, Math.round(settings.spread))
    : denseMask;
  const blurredMask = settings.blurRadius > 0
    ? await blurSingleChannelMask(spreadMask, settings.blurRadius)
    : spreadMask;
  const offsetMask = offsetAlpha(
    blurredMask,
    CANVAS_SIZE,
    CANVAS_SIZE,
    Math.round(settings.xOffset),
    Math.round(settings.yOffset)
  );
  const finalAlpha = applyHorizontalShadowMask(offsetMask, clamp(settings.opacity, 0, 1));
  return sharp({
    create: {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      channels: 3,
      background: {
        r: color.r,
        g: color.g,
        b: color.b
      }
    }
  })
    .joinChannel(finalAlpha, {
      raw: {
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        channels: 1
      }
    })
    .png()
    .toBuffer();
}

function applyShadowDensity(alpha: Buffer, density: number): Buffer {
  const multiplier = Math.max(0, density);

  if (multiplier <= 1) {
    return alpha;
  }

  const densityRadius = Math.round((multiplier - 1) * 4);

  return densityRadius > 0
    ? dilateAlpha(alpha, CANVAS_SIZE, CANVAS_SIZE, densityRadius)
    : alpha;
}

async function blurSingleChannelMask(alpha: Buffer, radius: number): Promise<Buffer> {
  const blurred = await sharp(alpha, {
    raw: {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      channels: 1
    }
  })
    .blur(radius)
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (blurred.info.channels === 1) {
    return blurred.data;
  }

  const output = Buffer.alloc(CANVAS_SIZE * CANVAS_SIZE);

  for (let index = 0; index < output.length; index += 1) {
    output[index] = blurred.data[index * blurred.info.channels];
  }

  return output;
}

function thresholdAlpha(alpha: Buffer): Buffer {
  const output = Buffer.alloc(alpha.length);

  for (let index = 0; index < alpha.length; index += 1) {
    output[index] = alpha[index] > 0 ? 255 : 0;
  }

  return output;
}

function dilateAlpha(alpha: Buffer, width: number, height: number, radius: number): Buffer {
  const horizontal = Buffer.alloc(alpha.length);
  const output = Buffer.alloc(alpha.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let max = 0;

      for (let dx = -radius; dx <= radius; dx += 1) {
        const sampleX = x + dx;

        if (sampleX >= 0 && sampleX < width) {
          max = Math.max(max, alpha[y * width + sampleX]);
        }
      }

      horizontal[y * width + x] = max;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let max = 0;

      for (let dy = -radius; dy <= radius; dy += 1) {
        const sampleY = y + dy;

        if (sampleY >= 0 && sampleY < height) {
          max = Math.max(max, horizontal[sampleY * width + x]);
        }
      }

      output[y * width + x] = max;
    }
  }

  return output;
}

function offsetAlpha(
  alpha: Buffer,
  width: number,
  height: number,
  xOffset: number,
  yOffset: number
): Buffer {
  const output = Buffer.alloc(alpha.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetX = x + xOffset;
      const targetY = y + yOffset;

      if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) {
        output[targetY * width + targetX] = alpha[y * width + x];
      }
    }
  }

  return output;
}

function applyHorizontalShadowMask(alpha: Buffer, opacity: number): Buffer {
  const output = Buffer.alloc(alpha.length);

  for (let y = 0; y < CANVAS_SIZE; y += 1) {
    for (let x = 0; x < CANVAS_SIZE; x += 1) {
      const index = y * CANVAS_SIZE + x;
      output[index] = Math.round(alpha[index] * opacity * maskAlphaAtX(x));
    }
  }

  return output;
}

function maskAlphaAtX(x: number): number {
  if (x < 100) {
    return 0;
  }

  if (x < 400) {
    return smoothstep((x - 100) / 300);
  }

  if (x <= 1600) {
    return 1;
  }

  if (x <= 1900) {
    return smoothstep((1900 - x) / 300);
  }

  return 0;
}

function smoothstep(value: number): number {
  const clamped = clamp(value, 0, 1);

  return clamped * clamped * (3 - 2 * clamped);
}

function parseHexColor(value: string): { r: number; g: number; b: number } {
  const normalized = value.trim().replace(/^#/, "");

  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error("Shadow color must be a 6-digit hex color");
  }

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
