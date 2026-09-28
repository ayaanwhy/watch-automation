"""Sandbox-headless makeCompareRB (Phase 15.7).

Adapted from post-scripts/makeCompareRB.py. For every SKU with a
`;frontFullImage` file and no existing `;compare` file in --dir, creates
`SKU;compare.<ext>` by trimming fully-transparent rows above/below the
frontFullImage — the exact same trim_transparent_rows algorithm as the
original script. Adds files; never overwrites an existing frontImage/
frontFullImage/compare.

Differences from the original: the original blocked on a Tkinter preview
window with Cancel/Create-images buttons before writing anything — that
can't run from a headless Electron-spawned subprocess, and Sandbox's own
Final Review is the real human checkpoint downstream, so this version
always proceeds directly to creating the proposed images. No hardcoded
personal TARGET_FOLDER — takes --dir. Final RESULT_JSON summary line.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageOps

TAGS = {"frontImage", "frontFullImage", "compare"}
IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}


def parse_sku_tag(path: Path):
    if path.suffix.lower() not in IMAGE_EXTENSIONS or path.name.startswith("."):
        return None
    if ";" not in path.stem:
        return None
    sku, tag = path.stem.rsplit(";", 1)
    return (sku, tag) if sku and tag in TAGS else None


def find_proposals(folder: Path):
    by_sku = defaultdict(lambda: defaultdict(list))
    for path in sorted(folder.iterdir()):
        if not path.is_file():
            continue
        parsed = parse_sku_tag(path)
        if parsed:
            sku, tag = parsed
            by_sku[sku][tag].append(path)

    proposals = []
    notes = []
    for sku, tagged_paths in sorted(by_sku.items()):
        if tagged_paths.get("compare") or not tagged_paths.get("frontFullImage"):
            continue
        source = tagged_paths["frontFullImage"][0]
        destination = source.with_name(f"{sku};compare{source.suffix}")
        if destination.exists():
            notes.append(f"Skipped {sku}: destination already exists")
            continue
        proposals.append((sku, source, destination))
    return proposals, notes


def trim_transparent_rows(image: Image.Image) -> Image.Image:
    if "A" not in image.getbands():
        if "transparency" not in image.info:
            return image.copy()
        image = image.convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        return image.copy()
    _, top, _, bottom = bbox
    return image.crop((0, top, image.width, bottom))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()

    folder = Path(args.dir)
    if not folder.is_dir():
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': f'Directory not found: {args.dir}'})}")
        sys.exit(1)

    try:
        proposals, notes = find_proposals(folder)
        created = []
        errors = []
        for sku, source, destination in proposals:
            try:
                with Image.open(source) as original:
                    trimmed = trim_transparent_rows(ImageOps.exif_transpose(original))
                    trimmed.save(destination)
                created.append(sku)
            except Exception as exc:  # noqa: BLE001 - per-SKU failure, report and continue
                errors.append({"sku": sku, "error": str(exc)})

        ok = len(errors) == 0
        print(f"RESULT_JSON:{json.dumps({'ok': ok, 'created': created, 'notes': notes, 'errors': errors})}")
        if not ok:
            sys.exit(1)
    except Exception as exc:  # noqa: BLE001 - report honestly, never fake success
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': str(exc)})}")
        sys.exit(1)


if __name__ == "__main__":
    main()
