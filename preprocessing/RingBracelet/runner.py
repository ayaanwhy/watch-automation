#!/usr/bin/env python3
"""
runner.py — Ring & Bracelet asset generator (Phase 10C; product dispatch
added in Phase 10E).

Consumes the transparent PNGs Universal Preprocessing has already produced
(background-removed, optionally upscaled) and bakes two assets per image:

  SKU;frontFullImage.png — the preprocessed image, unmodified.
  SKU;frontImage.png     — the same image with the shank-occluded region's
                            alpha reduced, using a per-product mask function.

This runner owns orchestration, batching, and file I/O; the mask-generation
step is the one part of the pipeline that diverges by product — everything
else here (protocol, batching, file naming, alpha subtraction) is shared and
identical regardless of --product. shank_mask.py (bracelet, verified) and
ring_mask.py (ring, independently developed) are both pure algorithm modules
with no I/O of their own — see their own docstrings for how each is
verified/unverified. SKU is the input filename's stem — there is no
spreadsheet/SKU-matching mechanism for Ring & Bracelet yet (that remains
Watch-specific).

Status (temporary, Phase 10E): ring_mask.py's dedicated rear-shank algorithm
is currently NOT wired in — both --product values run shank_mask.py's
proven bracelet implementation. This is an intentional, temporary rollback
of behavior, not an architectural one: the --product dispatch itself stays
in place in _process_one below, specifically so the dedicated ring
implementation can be re-enabled later by changing that one branch back to
generate_ring_mask(alpha).

Stdout protocol: NDJSON, one JSON object per line — the same shape as
electron_runner.py's, so the Electron main process can parse both with the
same conventions. No heartbeat: unlike BiRefNet/SAM2, nothing here runs long
enough per image to need one.

Exit codes (matching electron_runner.py):
  0 — every image succeeded
  1 — fatal startup failure, or zero images succeeded
  2 — partial success
  3 — cancelled cooperatively at a safe checkpoint

Cancellation: identical cooperative pattern to electron_runner.py — a
background thread reads {"cmd":"cancel"} from stdin and sets an in-memory
event; the main loop only checks it between images. There is no GPU work
here to protect, but the pattern is kept for consistency and because a
large batch should still be interruptible between images.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from shank_mask import generate_wrap_mask  # noqa: E402
# Imported but not currently called — see the temporary-rollback note on the
# --product dispatch in _process_one below and ring_mask.py's own docstring.
from ring_mask import generate_ring_mask  # noqa: E402,F401

EXIT_CANCELLED = 3

SUPPORTED_EXTENSIONS = {".png", ".webp"}


def emit(event: dict) -> None:
    print(json.dumps(event), file=sys.__stdout__, flush=True)


_CANCEL_EVENT = threading.Event()


def _stdin_listener() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(cmd, dict) and cmd.get("cmd") == "cancel" and not _CANCEL_EVENT.is_set():
            _CANCEL_EVENT.set()
            emit({"type": "cancel_requested"})


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="ring_bracelet_runner",
        description="Ring & Bracelet asset generator — shank-mask baking over Universal Preprocessing output.",
    )
    p.add_argument("--input-dir", required=True,
                   help="Folder of preprocessed transparent PNGs (Universal Preprocessing's output).")
    p.add_argument("--output-dir", required=True,
                   help="Folder for frontFullImage/frontImage outputs.")
    p.add_argument("--product", required=True, choices=("ring", "bracelet"),
                   help="Which mask implementation to use — shank_mask (bracelet) or ring_mask (ring).")
    p.add_argument("--split-y", type=float, default=0.5,
                   help="Fallback vertical split (band-relative) used when no hole topology is found. "
                        "Bracelet only — ring_mask.py does not currently use this.")
    return p.parse_args()


def _process_one(input_path: Path, output_dir: Path, product: str, split_y: float) -> dict:
    """Returns the fields to merge into a 'complete' event. Raises on failure."""
    img = Image.open(input_path).convert("RGBA")
    arr = np.array(img)
    alpha = arr[:, :, 3]

    # The only product-dispatched step in the whole pipeline — see module
    # docstring. Both functions share the same (mask, detected) contract, so
    # nothing below this line needs to know which product it is.
    if product == "ring":
        # Temporary rollback (Phase 10E): ring_mask.generate_ring_mask is
        # experimental and not yet validated broadly enough to run in
        # production — see ring_mask.py's module docstring for status. Both
        # branches currently call the proven bracelet implementation; the
        # --product dispatch itself stays in place so re-enabling the
        # dedicated ring algorithm later is a one-line change, right here:
        #     mask, detected = generate_ring_mask(alpha)
        mask, detected = generate_wrap_mask(alpha, split_y=split_y)
    else:
        mask, detected = generate_wrap_mask(alpha, split_y=split_y)

    front_full_path = output_dir / f"{input_path.stem};frontFullImage.png"
    front_path = output_dir / f"{input_path.stem};frontImage.png"

    # frontFullImage: the preprocessed image, unmodified (re-encoded to PNG
    # regardless of input format, so the output contract is always PNG).
    img.save(front_full_path)

    # frontImage: same image, alpha reduced in the shank-occluded region.
    # Never increases alpha — the occluded region can only become more
    # transparent, everywhere else is untouched.
    new_alpha = (alpha.astype(np.float32) * (1.0 - mask.astype(np.float32) / 255.0))
    new_alpha = np.clip(new_alpha, 0, 255).astype(np.uint8)
    front_arr = arr.copy()
    front_arr[:, :, 3] = new_alpha
    Image.fromarray(front_arr, mode="RGBA").save(front_path)

    return {
        "frontFullImage": str(front_full_path),
        "frontImage": str(front_path),
        "detected": bool(detected),
    }


def main() -> int:
    args = _parse_args()
    threading.Thread(target=_stdin_listener, daemon=True).start()

    input_dir = Path(args.input_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not input_dir.is_dir():
        emit({"type": "fatal", "error": f"Input directory not found: {input_dir}"})
        return 1

    images = sorted(
        p for p in input_dir.iterdir()
        if p.is_file() and not p.name.startswith("._")
        and p.suffix.lower() in SUPPORTED_EXTENSIONS
    )
    if not images:
        emit({"type": "fatal", "error": f"No supported images found in {input_dir}"})
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)

    total = len(images)
    emit({"type": "start", "total": total, "images": [p.name for p in images]})

    succeeded = 0
    failed = 0
    cancelled = False
    batch_t0 = time.perf_counter()

    for index, input_path in enumerate(images, start=1):
        if _CANCEL_EVENT.is_set():
            cancelled = True
            break

        image_t0 = time.perf_counter()
        emit({"type": "progress", "index": index, "total": total,
              "image": input_path.name, "stage": "shank_mask", "status": "start"})
        try:
            result = _process_one(input_path, output_dir, args.product, args.split_y)
            duration_ms = int((time.perf_counter() - image_t0) * 1000)
            emit({
                "type": "complete",
                "index": index,
                "total": total,
                "image": input_path.name,
                "duration_ms": duration_ms,
                **result,
            })
            succeeded += 1
        except Exception as exc:
            emit({
                "type": "error",
                "index": index,
                "total": total,
                "image": input_path.name,
                "error": str(exc),
                "fatal": False,
            })
            failed += 1

    total_ms = int((time.perf_counter() - batch_t0) * 1000)
    emit({
        "type": "done",
        "succeeded": succeeded,
        "failed": failed,
        "total_duration_ms": total_ms,
        "cancelled": cancelled,
    })

    if cancelled:
        return EXIT_CANCELLED
    if succeeded == 0:
        return 1
    if failed > 0:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
