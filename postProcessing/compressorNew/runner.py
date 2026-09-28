"""Sandbox-headless compressorNew (Phase 15.7).

Adapted from post-scripts/compressorNew.py. Compresses every PNG in
--input-dir into --output-dir. Output format is fixed to PNG (the approved
non-interactive default — see the Phase 15.7 conversation: no AVIF output
exists anywhere else in this repository, and pillow_avif isn't a guaranteed
dependency). Uses the same "quantize via imagequant if available, else plain
PNG optimize" fallback the original script had, so a machine without
imagequant installed still produces valid, just slightly larger, output
instead of failing.

Differences from the original: no interactive prompts, no hardcoded
personal folder list, single --input-dir/--output-dir pair (Sandbox always
gives one directory per stage), final RESULT_JSON summary line.
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

THREADS = 16


def process_image(in_path, out_path):
    with Image.open(in_path) as img:
        if img.mode in ("P", "PA"):
            img = img.convert("RGBA")

        try:
            import imagequant
            quantized = imagequant.quantize_pil_image(img, dithering_level=1.0, min_quality=0, max_quality=98)
            quantized.save(out_path, format="PNG", optimize=True)
        except ImportError:
            img.save(out_path, format="PNG", optimize=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    if not os.path.isdir(args.input_dir):
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': f'Input directory not found: {args.input_dir}'})}")
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    files = [f for f in os.listdir(args.input_dir) if f.lower().endswith(".png") and not f.startswith(".")]
    if not files:
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': 'No PNG images found in input directory.'})}")
        sys.exit(1)

    processed = []
    failed = []

    def run_one(filename):
        in_path = os.path.join(args.input_dir, filename)
        out_path = os.path.join(args.output_dir, filename)
        try:
            process_image(in_path, out_path)
            return {"filename": filename, "ok": True}
        except Exception as exc:  # noqa: BLE001 - per-file failure, report and continue
            return {"filename": filename, "ok": False, "error": str(exc)}

    with ThreadPoolExecutor(max_workers=THREADS) as executor:
        futures = {executor.submit(run_one, f): f for f in files}
        for future in as_completed(futures):
            result = future.result()
            if result["ok"]:
                processed.append(result["filename"])
            else:
                failed.append(result)

    ok = len(failed) == 0
    print(f"RESULT_JSON:{json.dumps({'ok': ok, 'processed': processed, 'failed': failed})}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
