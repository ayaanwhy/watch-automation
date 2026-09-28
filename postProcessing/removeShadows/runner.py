"""Sandbox-headless removeShadows — Watch shadow-alpha cleanup (Phase 15.7).

Adapted from post-scripts/removeShadows.py, with one deliberate change
approved in the Phase 15.7 conversation: the original script also
unconditionally rotated every image 270 degrees and trimmed the new left
edge. That rotation was written for an unrelated external dataset (its
hardcoded source folder was a different client's pre-existing export, not
anything from this repository's own Watch pipeline) and Sandbox's own
processWatch output is already correctly oriented — applying that rotation
here would silently rotate every completed Watch image sideways. So this
version keeps ONLY the shadow-alpha cleanup (drop any pixel below the alpha
threshold to fully transparent) and drops the rotate/trim step entirely.

Not to be confused with the existing Watch shadow-GENERATION pipeline
(packages/processing's own shadow synthesis under processWatch) — this is
a post-processing cleanup pass over already-generated Editing output, a
different concern with a coincidentally similar name.

Differences from the original beyond the dropped rotation: no hardcoded
personal folder paths (--input-dir/--output-dir), no tqdm dependency (a
plain loop is fast enough for an alpha-channel-only operation), final
RESULT_JSON summary line.
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

NUM_THREADS = 8


def process_image(image_path, output_path, threshold):
    with Image.open(image_path) as img:
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        alpha_channel = img.getchannel("A")
        new_alpha_channel = alpha_channel.point(lambda p: 0 if p < threshold else p)
        img.putalpha(new_alpha_channel)
        img.save(output_path, "PNG")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--threshold", type=int, default=90)
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
            process_image(in_path, out_path, args.threshold)
            return {"filename": filename, "ok": True}
        except Exception as exc:  # noqa: BLE001 - per-file failure, report and continue
            return {"filename": filename, "ok": False, "error": str(exc)}

    with ThreadPoolExecutor(max_workers=NUM_THREADS) as executor:
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
