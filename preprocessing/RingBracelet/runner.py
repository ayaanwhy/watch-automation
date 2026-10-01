#!/usr/bin/env python3
"""
runner.py — Ring & Bracelet asset generator (Phase 10C; product dispatch
added in Phase 10E; orchestration shared with Universal Preprocessing via
runner_base.py in Phase 11D; Automatic/Manual processing modes and shadow
generation added in Phase 11.5C; idempotent reruns added in Phase 11.5D,
mirroring electron_runner.py's Phase 11E behavior — an image whose expected
outputs already exist is skipped rather than reprocessed).

Consumes the transparent PNGs Universal Preprocessing has already produced
(background-removed, optionally upscaled) and bakes two assets per image:

  SKU;frontFullImage.png — the preprocessed image, unmodified.
  SKU;frontImage.png     — the same image with the shank-occluded region's
                            alpha reduced (--processing-mode=automatic only;
                            skipped entirely in manual mode — see below),
                            then the Ring & Bracelet shadow profile applied
                            (shadow.py) — both processing modes converge on
                            this same shadow step.

--processing-mode (automatic, the default, or manual) is the shared
Automatic/Manual workflow abstraction (IMPLEMENTATION_PLAN.md, Phase
11.5C) applied to this pipeline: automatic runs the masking step below
exactly as before; manual treats the input as already masked externally
and skips straight to shadow generation.

This runner owns only its own per-image processing; batching, cancellation,
input discovery, and the NDJSON/exit-code protocol come from runner_base.py
(shared with electron_runner.py) — see that module's docstring. The mask-
generation step is the one part of the pipeline that diverges by product —
everything else here (file naming, alpha subtraction, shadow generation) is
shared and identical regardless of --product. shank_mask.py (bracelet,
verified) and ring_mask.py (ring, independently developed) are both pure
algorithm modules with no I/O of their own — see their own docstrings for
how each is verified/unverified. SKU is the input filename's stem — there
is no spreadsheet/SKU-matching mechanism for Ring & Bracelet yet (that
remains Watch-specific).

Segmentation routing (explicit, per product):
  --product ring     -> ring_segmentation/ (PixelForge-derived ONNX ring model:
                        the front/rear-band ownership decision — see
                        ring_segmentation/front_ownership.py). The input is
                        already background-removed; no second background
                        removal runs, and the model is never loaded for bracelets.
  --product bracelet -> shank_mask.generate_wrap_mask (the original CV
                        implementation, unchanged).
ring_mask.py's earlier experimental ring algorithm stays unused (as before).
Only the mask step differs by product; frontFullImage, the alpha subtraction
and the shadow step are shared and unchanged.

No heartbeat: unlike BiRefNet/SAM2, nothing here runs long enough per image
to need one. No GPU work here to protect from cancellation either, but the
cooperative pattern (from runner_base) is kept for consistency and because a
large batch should still be interruptible between images.
"""
from __future__ import annotations

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
# runner_base.py lives at the monorepo's preprocessing/ root, one level up —
# shared with electron_runner.py, which resolves it the same way.
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

# ring_segmentation/ holds the PixelForge-derived Ring model. Its onnxruntime /
# model files are only touched when --product ring runs the automatic masking
# step (front_ownership imports the model lazily), so bracelets and manual mode
# never load it.
_RING_SEGMENTATION_DIR = _HERE / "ring_segmentation"
if str(_RING_SEGMENTATION_DIR) not in sys.path:
    sys.path.insert(0, str(_RING_SEGMENTATION_DIR))

from shank_mask import generate_wrap_mask  # noqa: E402
# Imported but not currently called — ring_mask.py's own experimental ring
# algorithm; Rings now use the model-based ownership below instead.
from ring_mask import generate_ring_mask  # noqa: E402,F401
import front_ownership  # noqa: E402
from shadow import composite_with_shadow, RING_BRACELET_SHADOW  # noqa: E402
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
    # Phase 11.5C — Automatic / Manual is a shared workflow abstraction (see
    # IMPLEMENTATION_PLAN.md), not a Ring & Bracelet-specific concept.
    # Automatic runs the masking step below exactly as before; Manual skips
    # it entirely (the input is treated as already masked externally) and
    # both converge on the same shadow-generation step.
    p.add_argument("--processing-mode", choices=("automatic", "manual"), default="automatic",
                   help="Automatic: run the shank/wrap masking workflow before continuing. "
                        "Manual: masking has already been done externally — skip straight to "
                        "shadow generation. (default: automatic)")
    # Phase 13H — optional override for the shadow settings normally hardcoded
    # as shadow.py's RING_BRACELET_SHADOW, sourced from the desktop app's
    # Settings → Shadow Profiles. See _load_shadow_settings for the
    # byte-identical-by-default guarantee.
    p.add_argument("--shadow-profile-file", type=str, default=None,
                   help="Optional path to a JSON sidecar (written by the desktop app) containing a "
                        "possibly-customized 'ringBracelet' shadow settings dict. Omitted, unreadable, "
                        "or missing the key falls back to shadow.py's RING_BRACELET_SHADOW default.")
    return p.parse_args()


def _load_shadow_settings(profile_file: str | None, key: str, fallback: dict) -> dict:
    """Resolves the shadow settings dict to use for this run. An absent
    --shadow-profile-file, an unreadable file, or a missing key all fall back
    to `fallback` (shadow.py's own hardcoded default) — this is what keeps
    the default production path byte-identical unless a user has explicitly
    edited and saved that profile in Settings (Phase 13H).
    """
    if not profile_file:
        return fallback
    try:
        with open(profile_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return fallback
    settings = data.get(key)
    return settings if isinstance(settings, dict) else fallback


def _expected_output_paths(input_path: Path, output_dir: Path) -> tuple[Path, Path]:
    return (
        output_dir / f"{input_path.stem};frontFullImage.png",
        output_dir / f"{input_path.stem};frontImage.png",
    )


def _process_one_image(
    input_path: Path,
    output_dir: Path,
    product: str,
    split_y: float,
    processing_mode: str,
    shadow_settings: dict,
    on_stage=None,
) -> dict:
    """Returns the fields to merge into a 'complete' event. Raises on failure."""
    img = Image.open(input_path).convert("RGBA")
    arr = np.array(img)
    alpha = arr[:, :, 3]

    if processing_mode == "manual":
        # Masking has already been done externally (per-SKU input already
        # background-removed and manually prepared) — nothing to detect, and
        # nothing here should be flagged as a low-confidence automatic
        # result (Batch Details' "needs review" badge keys off
        # detected === false, not the absence of masking).
        masked_alpha = alpha
        detected = True
    else:
        # The only product-dispatched step in the whole pipeline — see
        # module docstring. Both branches share the same (mask, detected)
        # contract, so nothing below this line needs to know which product
        # it is.
        if product == "ring":
            # PixelForge-derived ring model: receives the already-background-
            # removed image (composited on flat white for the model), returns
            # the rear-band ownership mask. Raises RingSegmentationError with
            # a stable [RING_SEGMENTATION_*] token on failure.
            mask, detected = front_ownership.generate_ring_model_mask(arr)
            if on_stage is not None:
                on_stage("shadow")  # segmentation done; the shadow step starts
        else:
            mask, detected = generate_wrap_mask(alpha, split_y=split_y)

        # Alpha reduced in the shank-occluded region. Never increases alpha
        # — the occluded region can only become more transparent, everywhere
        # else is untouched.
        masked_alpha = (alpha.astype(np.float32) * (1.0 - mask.astype(np.float32) / 255.0))
        masked_alpha = np.clip(masked_alpha, 0, 255).astype(np.uint8)

    front_full_path, front_path = _expected_output_paths(input_path, output_dir)

    # frontFullImage: the preprocessed image, unmodified (re-encoded to PNG
    # regardless of input format, so the output contract is always PNG) —
    # unconditional, same in both processing modes.
    img.save(front_full_path)

    # frontImage: the (possibly masked) image with the Ring & Bracelet
    # shadow profile applied — the shared downstream step both processing
    # modes converge on. See shadow.py for the ported algorithm.
    masked_arr = arr.copy()
    masked_arr[:, :, 3] = masked_alpha
    masked_img = Image.fromarray(masked_arr, mode="RGBA")
    shadowed_img = composite_with_shadow(masked_img, shadow_settings)
    shadowed_img.save(front_path)

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

    # Ring automatic mode needs the model: fail the whole job up front, with a
    # stable [RING_SEGMENTATION_*] token, rather than once per image.
    if args.product == "ring" and args.processing_mode == "automatic":
        try:
            front_ownership.preflight()
        except front_ownership.RingSegmentationError as exc:
            rb.emit({"type": "fatal", "error": str(exc)})
            return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    rb.emit_start(images)

    # Resolved once, before the per-image loop — see _load_shadow_settings
    # for the byte-identical-by-default guarantee (Phase 13H).
    ring_bracelet_settings = _load_shadow_settings(
        args.shadow_profile_file, "ringBracelet", RING_BRACELET_SHADOW
    )

    def process_one(index: int, total: int, input_path: Path) -> None:
        t0 = time.perf_counter()
        front_full_path, front_path = _expected_output_paths(input_path, output_dir)

        # Idempotent reruns (Phase 11.5D) — mirrors electron_runner.py's
        # existing behavior (Phase 11E): an image whose expected outputs
        # already exist was already processed in a previous run against
        # this same output directory — most commonly, retrying a batch a
        # crash or force-quit interrupted. Skip straight to reporting it
        # complete instead of reprocessing. `detected` is reported as True
        # on skip — a neutral placeholder, not a re-derived value, the same
        # accepted information loss electron_runner.py's own skip path has
        # for `masks`.
        if front_full_path.exists() and front_path.exists():
            print(f"Skipping {input_path.name} — output already exists.", file=sys.stderr)
            duration_ms = int((time.perf_counter() - t0) * 1000)
            rb.emit({
                "type": "complete",
                "index": index,
                "total": total,
                "image": input_path.name,
                "duration_ms": duration_ms,
                "frontFullImage": str(front_full_path),
                "frontImage": str(front_path),
                "detected": True,
            })
            return

        def emit_stage(stage: str) -> None:
            rb.emit({"type": "progress", "index": index, "total": total,
                      "image": input_path.name, "stage": stage, "status": "start"})

        if args.processing_mode != "automatic":
            emit_stage("shadow")
        elif args.product == "ring":
            emit_stage("ring_segmentation")
        else:
            emit_stage("shank_mask")
        result = _process_one_image(
            input_path, output_dir, args.product, args.split_y, args.processing_mode, ring_bracelet_settings,
            # Ring only: announces the shadow step once its mask exists, so
            # progress can tell segmentation and editing apart.
            on_stage=emit_stage,
        )
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
