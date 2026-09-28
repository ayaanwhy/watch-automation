"""Sandbox-headless autoMCFF — Ring/Bracelet variant (Phase 15.7).

Per the approved Phase 15.7 decision: this is a variation of
post-scripts/autoMCFF.py's core calculation (assumed width -> height via
image aspect ratio) combined with post-scripts/autoMCRB.py's real CSV
artifact output, using a fixed default assumed width per product type
(60mm for Bracelet, 20mm for Ring) rather than either script's single
global constant or a per-SKU measurement — this was an explicit product
decision, not inferred from Sandbox's normalized per-SKU widthMm data.

Runs after makeCompareRB in the canonical Ring/Bracelet order, so it reads
the `;compare` image for each SKU (falling back to `;frontFullImage` if a
SKU has no compare image, since this step is optional and shouldn't crash
if enabled without makeCompareRB somehow having produced one) and computes
width x height in mm assuming --assumed-width-mm is the image's real-world
width. Writes dimensions.csv (SKU, Width, Height) into --dir — a real
artifact, not print-only.

Non-interactive: no folder-scope choice prompt (always considers every SKU
present). Final RESULT_JSON summary line.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

from PIL import Image

IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}


def find_measurement_image(folder: Path, sku: str) -> Path | None:
    for tag in ("compare", "frontFullImage"):
        for ext in IMAGE_EXTENSIONS:
            candidate = folder / f"{sku};{tag}{ext}"
            if candidate.exists():
                return candidate
    return None


def discover_skus(folder: Path) -> list[str]:
    skus = []
    seen = set()
    for path in sorted(folder.iterdir()):
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS or path.name.startswith("."):
            continue
        if ";" not in path.stem:
            continue
        sku = path.stem.split(";", 1)[0]
        if sku not in seen:
            seen.add(sku)
            skus.append(sku)
    return skus


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    parser.add_argument("--assumed-width-mm", required=True, type=float)
    parser.add_argument("--output-csv", required=True)
    args = parser.parse_args()

    folder = Path(args.dir)
    if not folder.is_dir():
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': f'Directory not found: {args.dir}'})}")
        sys.exit(1)

    try:
        rows = []
        skipped = []
        for sku in discover_skus(folder):
            image_path = find_measurement_image(folder, sku)
            if image_path is None:
                skipped.append(sku)
                continue
            with Image.open(image_path) as img:
                width_px, height_px = img.size
            aspect_ratio = height_px / width_px
            height_mm = round(args.assumed_width_mm * aspect_ratio, 2)
            rows.append([sku, round(args.assumed_width_mm, 2), height_mm])

        with open(args.output_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["SKU", "Width", "Height"])
            writer.writerows(rows)

        print(f"RESULT_JSON:{json.dumps({'ok': True, 'measured': len(rows), 'skipped': skipped, 'csv': args.output_csv})}")
    except Exception as exc:  # noqa: BLE001 - report honestly, never fake success
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': str(exc)})}")
        sys.exit(1)


if __name__ == "__main__":
    main()
