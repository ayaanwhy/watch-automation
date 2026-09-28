// Shared Rotation image operation (Phase 15.1) — see
// ../../src/constants/rotation.ts for the type/why this is independent of
// EditingHandoffRotate. Main-process-safe (fs + sharp), with no Legacy- or
// Sandbox-specific dependency, so both can call it directly once their own
// orchestration wires it in (out of scope this phase — see
// IMPLEMENTATION_PLAN.md Phase 15.1).
import { copyFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { RotationDegrees } from '../../src/constants/rotation'

export type RotateImageResult =
  | { ok: true; width: number; height: number }
  | { ok: false; error: string }

// Output is always written as PNG regardless of the input format (alpha
// is preserved/ensured for the transparent-background product images this
// runs on) — callers should pass an outputPath ending in .png.
export async function rotateImage(
  inputPath: string,
  outputPath: string,
  degrees: RotationDegrees,
): Promise<RotateImageResult> {
  try {
    if (degrees === 0) {
      // Preserve existing 0° (identity) behavior exactly — a byte-for-byte
      // copy, not a re-encode through sharp, so 0° never alters pixels or
      // file bytes.
      await copyFile(inputPath, outputPath)
      const metadata = await sharp(inputPath).metadata()
      if (!metadata.width || !metadata.height) {
        return { ok: false, error: 'Source image has no readable dimensions.' }
      }
      return { ok: true, width: metadata.width, height: metadata.height }
    }

    // ensureAlpha() guarantees an alpha channel exists, even for a source
    // with none (e.g. an opaque JPEG). Quarter-turns are lossless pixel
    // remaps: 90°/270° swap width and height, 180° keeps them — the actual
    // output geometry is read back from sharp's own result below.
    const info = await sharp(inputPath)
      .ensureAlpha()
      .rotate(degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outputPath)

    return { ok: true, width: info.width, height: info.height }
  } catch (err) {
    return { ok: false, error: `Failed to rotate image: ${String(err)}` }
  }
}
