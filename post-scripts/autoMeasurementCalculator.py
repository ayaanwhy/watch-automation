#!/usr/bin/env python3
"""
Measure image widths in mm and save results to an Excel file.

Rules:
- All input images are expected to have height = 1000 px.
- If aspect_ratio (width/height) >= long_ratio_threshold -> classified "Long"
    -> scale: 1000 px == 40 mm  => px_per_mm = 25
- Otherwise -> classified "Squareish"
    -> scale: 1000 px == 20 mm  => px_per_mm = 50

Output: measurements.xlsx saved inside the target folder.
"""

import os
from pathlib import Path
from PIL import Image
import pandas as pd

# --- USER CONFIG ---
INPUT_FOLDER = "/Volumes/PortableSSD 1/demo clients/misc/compare-demo/earrings"
OUTPUT_FILENAME = "measurements.xlsx"
long_ratio_threshold = 0.8
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}
# --------------------

def px_to_mm(width_px: int, classification: str) -> float:
    if classification == "Long":
        px_per_mm = 1000 / 40.0
    else:
        px_per_mm = 1000 / 15.0
    return width_px / px_per_mm

def classify_image(width, height, threshold):
    ratio = width / float(height)
    return "Long" if ratio < threshold else "Squareish"  # flipped logic

def scan_and_measure(input_folder: str, output_filename: str, threshold: float):
    input_path = Path(input_folder)
    if not input_path.exists() or not input_path.is_dir():
        raise ValueError(f"Input folder does not exist or is not a directory: {input_folder}")

    rows = []

    for file in sorted(input_path.iterdir()):
        if not file.is_file() or file.suffix.lower() not in EXTS:
            continue

        try:
            with Image.open(file) as img:
                width_px, height_px = img.size

                classification = classify_image(width_px, height_px, threshold)
                assumed_height_mm = 40 if classification == "Long" else 15
                width_mm = px_to_mm(width_px, classification)
                aspect_ratio = width_px / float(height_px)

                rows.append({
                    "filename": file.name,
                    "width_mm": round(width_mm, 3),
                    "height_mm": assumed_height_mm,
                    "assumed_height_mm": assumed_height_mm,
                    "width_px": int(width_px),
                    "height_px": int(height_px),
                    "aspect_ratio": round(aspect_ratio, 3),
                    "classification": classification,
                    "px_per_mm": round(1000 / assumed_height_mm, 3),
                })

                print(
                    f"{file.name} — "
                    f"{round(width_mm,3)} mm × {assumed_height_mm} mm — "
                    f"{classification}"
                )

        except Exception as e:
            print(f"Error reading {file.name}: {e}")

    if rows:
        df = pd.DataFrame(rows, columns=[
            "filename",
            "width_mm",
            "height_mm",
            "assumed_height_mm",
            "width_px",
            "height_px",
            "aspect_ratio",
            "classification",
            "px_per_mm",
        ])

        out_path = input_path / output_filename
        df.to_excel(out_path, index=False)
        print(f"\nSaved {len(rows)} measurements to: {out_path}")
    else:
        print("No valid image files found in folder.")

if __name__ == "__main__":
    scan_and_measure(INPUT_FOLDER, OUTPUT_FILENAME, long_ratio_threshold)
