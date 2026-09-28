"""Sandbox-headless resizeGems (automation-engine hardening pass).

Adapted from post-scripts/resizeGems.py (which is left untouched). The core
algorithm is unchanged: each gemstone image is resized so that its width
equals the sheet Width (mm) at CANVAS_PX/CANVAS_MM pixels-per-mm, then
centered on a transparent CANVAS_PX-wide canvas. Pear-shaped stones (Shape
contains "pear", case-insensitive) are force-rotated 90 degrees clockwise
and sized from Height instead of Width. For every other shape the
"rotation check" rotates 90 degrees clockwise only when the image's longer
side (px) disagrees with the sheet's longer side (mm) — enabled by an
explicit product decision (the original prompted for it).

Differences from the original personal script:
  - No interactive confirm/prompts; always proceeds (Sandbox's Final Review
    is the human checkpoint).
  - No hardcoded folders/spreadsheet: takes --input-dir/--output-dir and an
    --items-file JSON sidecar ({SKU: {"widthMm":..,"heightMm":..,"shape":..}})
    built by the adapter from Sandbox's normalized product data. Shape is
    required for every item and is never defaulted here.
  - Final RESULT_JSON line reporting exactly what was produced/failed.
Artifact flow (Gemstone): this wrapper consumes ONLY `SKU;compare.png` — the
trimmed, background-removed Gemstone Editing artifact, which is the canonical
before/reference image — never the raw preprocessing output. For each SKU it
  1. copies the compare into --output-dir UNCHANGED (byte copy),
  2. applies the resize/centering/shape processing to a duplicate, and
  3. saves the result as `SKU;frontImage.png`.
The input compare is never modified or overwritten. (The original script
wrote `SKU.png`; the `;frontImage` tag is the project's final-artifact
convention.)
"""
import argparse
import json
import os
import shutil
import sys

from PIL import Image

CANVAS_PX = 2000
CANVAS_MM = 20


def is_pear(shape):
    return "pear" in (shape or "").lower()


def parse_compare(filename):
    """Return the SKU when `filename` is `SKU;compare.png`, else None."""
    stem = os.path.splitext(filename)[0]
    if ";" not in stem:
        return None
    sku, tag = stem.rsplit(";", 1)
    return sku if sku and tag == "compare" else None


def process_one(in_path, out_path, width_mm, height_mm, shape):
    px_per_mm = CANVAS_PX / CANVAS_MM
    pear = is_pear(shape)
    target_mm = height_mm if pear else width_mm  # pear: axes swap after rotation
    new_w = int(round(target_mm * px_per_mm))
    if new_w <= 0 or new_w > CANVAS_PX:
        raise ValueError(f"computed width {new_w}px is outside the {CANVAS_PX}px canvas")

    with Image.open(in_path) as img:
        img.load()
        orig_w, orig_h = img.size
        method = "normal"
        if pear:
            img = img.rotate(-90, expand=True)
            orig_w, orig_h = img.size
            method = "pear-forced"
        else:
            mm_longer_is_width = width_mm >= height_mm
            px_longer_is_width = orig_w >= orig_h
            if mm_longer_is_width != px_longer_is_width:
                img = img.rotate(-90, expand=True)
                orig_w, orig_h = img.size
                method = "conditional"

        scale = new_w / orig_w
        new_h = int(round(orig_h * scale))
        resized = img.resize((new_w, new_h), Image.LANCZOS).convert("RGBA")
        canvas = Image.new("RGBA", (CANVAS_PX, new_h), (0, 0, 0, 0))
        canvas.paste(resized, ((CANVAS_PX - new_w) // 2, 0), resized)
        canvas.save(out_path)
    return method


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--items-file", required=True)
    args = parser.parse_args()

    def fail(message):
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': message})}")
        sys.exit(1)

    if not os.path.isdir(args.input_dir):
        fail(f"Input directory not found: {args.input_dir}")
    try:
        with open(args.items_file, "r", encoding="utf-8") as fh:
            items = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        fail(f"Could not read items file: {exc}")

    os.makedirs(args.output_dir, exist_ok=True)
    files = sorted(f for f in os.listdir(args.input_dir) if f.lower().endswith(".png") and not f.startswith("."))
    processed, failed, unmatched = [], [], []
    seen = set()
    for filename in files:
        sku = parse_compare(filename)
        if sku is None:
            continue  # only ;compare artifacts are consumed — never raw images
        if sku in seen:
            continue
        row = items.get(sku)
        if row is None:
            unmatched.append(sku)
            continue
        seen.add(sku)
        try:
            width, height, shape = row.get("widthMm"), row.get("heightMm"), row.get("shape")
            if not shape or not (isinstance(width, (int, float)) and width > 0) or not (isinstance(height, (int, float)) and height > 0):
                raise ValueError("width, height and shape are all required")
            compare_in = os.path.join(args.input_dir, filename)
            # The compare travels to the output untouched; the resize acts on a duplicate.
            shutil.copyfile(compare_in, os.path.join(args.output_dir, filename))
            method = process_one(compare_in, os.path.join(args.output_dir, f"{sku};frontImage.png"), float(width), float(height), shape)
            processed.append({"sku": sku, "method": method})
        except Exception as exc:  # noqa: BLE001 - per-SKU failure, report and continue
            failed.append({"sku": sku, "error": str(exc)})

    ok = len(failed) == 0 and len(processed) > 0
    print(f"RESULT_JSON:{json.dumps({'ok': ok, 'processed': processed, 'failed': failed, 'unmatched': unmatched})}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
