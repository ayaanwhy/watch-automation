#!/usr/bin/env python3
"""
runner.py — Ring & Bracelet asset generator (Phase 10C; product dispatch
added in Phase 10E; orchestration shared with Universal Preprocessing via
runner_base.py in Phase 11D).

Consumes the transparent PNGs Universal Preprocessing has already produced
(background-removed, optionally upscaled) and bakes two assets per image:

  SKU;frontFullImage.png — the preprocessed image, unmodified.
  SKU;frontImage.png     — the same image with the shank-occluded region's
                            alpha reduced, using a per-product mask function.

This runner owns only its own per-image processing; batching, cancellation,
input discovery, and the NDJSON/exit-code protocol come from runner_base.py
(shared with electron_runner.py) — see that module's docstring. The mask-
generation step is the one part of the pipeline that diverges by product —
everything else here (file naming, alpha subtraction) is shared and
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

No heartbeat: unlike BiRefNet/SAM2, nothing here runs long enough per image
to need one. No GPU work here to protect from cancellation either, but the
cooperative pattern (from runner_base) is kept for consistency and because a
large batch should still be interruptible between images.
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
# runner_base.py lives at the monorepo's preprocessing/ root, one level up —
# shared with electron_runner.py, which resolves it the same way.
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from shank_mask import generate_wrap_mask  # noqa: E402
# Imported but not currently called — see the temporary-rollback note on the
# --product dispatch in _process_one below and ring_mask.py's own docstring.
from ring_mask import generate_ring_mask  # noqa: E402,F401
import runner_base as rb  # noqa: E402

SUPPORTED_EXTENSIONS = {".png", ".webp"}


def _parse_args():
    import argparse
    p = argparse.ArgumentParser(
        prog="ring_bracelet_runner",
        description="Ring & Bracelet asset generator — shank-mask baking over Universal Preprocessing output.",
    )
    rb.add_common_io_args(p)
    p.add_argument("--product", required=True, choices=("ring", "bracelet"),
                   help="Which mask implementation to use — shank_mask (bracelet) or ring_mask (ring).")
    p.add_argument("--split-y", type=float, default=0.5,
                   help="Fallback vertical split (band-relative) used when no hole topology is found. "
                        "Bracelet only — ring_mask.py does not currently use this.")
    return p.parse_args()


def _process_one_image(input_path: Path, output_dir: Path, product: str, split_y: float) -> dict:
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
    cancel_event = threading.Event()
    rb.start_cancel_listener(cancel_event)

    input_dir, output_dir = rb.resolve_io_dirs(args.input_dir, args.output_dir)

    images = rb.discover_and_validate(input_dir, SUPPORTED_EXTENSIONS)
    if images is None:
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    rb.emit_start(images)

    def process_one(index: int, total: int, input_path: Path) -> None:
        rb.emit({"type": "progress", "index": index, "total": total,
                  "image": input_path.name, "stage": "shank_mask", "status": "start"})
        t0 = time.perf_counter()
        result = _process_one_image(input_path, output_dir, args.product, args.split_y)
        duration_ms = int((time.perf_counter() - t0) * 1000)
        rb.emit({
            "type": "complete",
            "index": index,
            "total": total,
            "image": input_path.name,
            "duration_ms": duration_ms,
            **result,
        })

    outcome = rb.run_batch(images, cancel_event, process_one)
    return rb.emit_done_and_exit_code(outcome)


if __name__ == "__main__":
    sys.exit(main())
