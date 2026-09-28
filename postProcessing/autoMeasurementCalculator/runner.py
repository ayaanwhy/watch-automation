"""Sandbox-headless autoMeasurementCalculator — Earring (Phase 15.7).

Adapted from post-scripts/autoMeasurementCalculator.py. The core
classification/measurement algorithm is unchanged: every input image is
assumed to be height=1000px in its working canvas; the width/height pixel
aspect ratio classifies it "Long" or "Squareish" against a fixed threshold,
each classification implies a fixed assumed real-world height in mm, and
the real-world width is derived from that assumption. This produces
measurement DATA, not another image — per Phase 15.7's explicit
instruction, that's represented as a proper metadata artifact
(measurements.xlsx), not disguised as an image output.

Differences from the original: no hardcoded personal INPUT_FOLDER (takes
--input-dir/--output-dir), source images are copied through to --output-dir
unchanged (so the post-processing chain still has an image directory to
hand to Final Review even though this script's own job is measurement, not
image transformation), final RESULT_JSON summary line. The original script
already had no interactive input() calls, so no interactivity was removed.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import pandas as pd
from PIL import Image

OUTPUT_FILENAME = "measurements.xlsx"
LONG_RATIO_THRESHOLD = 0.8
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}


def px_to_mm(width_px: int, classification: str) -> float:
    px_per_mm = 1000 / 40.0 if classification == "Long" else 1000 / 15.0
    return width_px / px_per_mm


def classify_image(width: int, height: int, threshold: float) -> str:
    ratio = width / float(height)
    return "Long" if ratio < threshold else "Squareish"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    input_path = Path(args.input_dir)
    if not input_path.is_dir():
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': f'Input directory not found: {args.input_dir}'})}")
        sys.exit(1)

    output_path = Path(args.output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    try:
        rows = []
        for file in sorted(input_path.iterdir()):
            if not file.is_file() or file.suffix.lower() not in EXTS or file.name.startswith("."):
                continue

            shutil.copy2(file, output_path / file.name)

            with Image.open(file) as img:
                width_px, height_px = img.size

            classification = classify_image(width_px, height_px, LONG_RATIO_THRESHOLD)
            assumed_height_mm = 40 if classification == "Long" else 15
            width_mm = px_to_mm(width_px, classification)

            rows.append({
                "filename": file.name,
                "width_mm": round(width_mm, 3),
                "height_mm": assumed_height_mm,
                "width_px": int(width_px),
                "height_px": int(height_px),
                "classification": classification,
            })

        if not rows:
            print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': 'No valid image files found in input directory.'})}")
            sys.exit(1)

        df = pd.DataFrame(rows, columns=["filename", "width_mm", "height_mm", "width_px", "height_px", "classification"])
        out_xlsx = output_path / OUTPUT_FILENAME
        df.to_excel(out_xlsx, index=False)

        print(f"RESULT_JSON:{json.dumps({'ok': True, 'measured': len(rows), 'xlsx': str(out_xlsx)})}")
    except Exception as exc:  # noqa: BLE001 - report honestly, never fake success
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': str(exc)})}")
        sys.exit(1)


if __name__ == "__main__":
    main()
