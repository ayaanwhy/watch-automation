#!/usr/bin/env python3
"""
runner.py — Earring asset generator (Phase 12C; Hoop Automatic added in
Phase 12D; orchestration shared with Universal Preprocessing / Ring &
Bracelet via runner_base.py).

Consumes the transparent PNGs Universal Preprocessing has already produced
(background-removed, resized to 1000px height per Phase 12A) and bakes
assets per image, dispatched by the earring type resolved for that SKU:

  SKU;compare.png         — the preprocessed image, unmodified. The
                             immutable input every downstream editing
                             operation derives from (Phase 12 Architectural
                             Rules) — never itself modified by any editing
                             operation. Written unconditionally, regardless
                             of type or outcome.
  SKU;frontImage.png      — Stud/Drop: compare with the shared shadow
                             engine's composite_with_shadow() applied
                             (EARRING_SHADOW, per-type casting region: Stud
                             full silhouette, Drop top 10% anchor region).
                             Hoop: the rear portion made transparent (never
                             cropped — see _process_hoop) with a shadow cast
                             from its own remaining top 10%, composited
                             directly via create_drop_shadow() on a canvas
                             matching compare's own dimensions exactly (no
                             padding, no post-shadow trim — Phase 12
                             Resolved Decision 4's alignment contract).
  SKU;frontFullImage.png  — Hoop only: an unmodified duplicate of compare,
                             retained for downstream Virtual Try-On usage
                             (Phase 12 Architectural Rules). Stud/Drop never
                             produce this file.

Earring type is resolved per SKU from a sidecar JSON file the Electron main
process writes before spawning this runner (--metadata-file), NOT
re-interpreted here from Category/Sub-Category — this runner only ever does
a dict lookup by SKU. All classification logic lives in one place, Electron
(metadataHandlers.ts / earringHandlers.ts, Phase 12B/12C); keeping it there
was the explicit intent behind building the metadata system in 12B, and this
runner deliberately does not duplicate it. A SKU missing from the sidecar is
a per-image error, the same as an unsupported type.

Automatic/Manual (Phase 11.5C shared workflow abstraction): Stud and Drop
behave identically in both modes — neither has a masking step, so both
converge on shadow generation directly (IMPLEMENTATION_PLAN.md, Phase 12
Resolved Decision 7). Hoop diverges: Automatic runs hoop_mask.py's front/rear
split detection; Manual (Phase 12E) reads a pre-resolved per-SKU normalized
split position from --splits-file instead, and reuses the exact same
hoop_mask.build_mask_from_split_x rendering step Automatic uses — the two
modes differ only in where split_x comes from, never in how the mask itself
is built.

--splits-file (Phase 12E, JSON {sku: normalized_x}) is written by the
Electron main process from the batch registry's persisted
config.hoopSplits — the same "resolved runtime artifact, never
re-interpreted here" pattern --metadata-file already uses (Phase 12B/12C).
A hoop SKU with no entry in the sidecar in Manual mode is a per-image error,
the same as an unresolved type.
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
# runner_base.py and shadow.py both live at the monorepo's preprocessing/
# root, one level up — same resolution pattern electron_runner.py and
# RingBracelet/runner.py already use.
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from shadow import composite_with_shadow, create_drop_shadow, EARRING_SHADOW  # noqa: E402
from hoop_mask import generate_hoop_mask, build_mask_from_split_x  # noqa: E402
import runner_base as rb  # noqa: E402

SUPPORTED_EXTENSIONS = {".png", ".webp"}

# Per-type shadow casting region (Phase 12 Resolved Decision: "Shadow
# casting region: Stud: Entire silhouette; Drop: Upper anchor region (~10%);
# Hoop: Upper anchor region (~10%) after front-half isolation"). Stud maps
# to None (no casting_region key -> shadow.py's default, full silhouette).
# Hoop uses the same 0.10 value as Drop but is not looked up here — its
# casting region is applied inside _process_hoop, on top of the already
# rear-masked alpha (front-half isolation happens first), not via
# composite_with_shadow (see _process_hoop's own docstring for why Hoop
# bypasses that wrapper entirely).
CASTING_REGION_BY_TYPE = {
    "stud": None,
    "drop": 0.10,
}

HOOP_CASTING_REGION = 0.10


def _parse_args():
    import argparse
    p = argparse.ArgumentParser(
        prog="earring_runner",
        description="Earring asset generator — shadow baking over Universal Preprocessing output, dispatched by resolved earring type.",
    )
    rb.add_common_io_args(p)
    p.add_argument("--metadata-file", required=True,
                   help="JSON sidecar {sku: 'stud'|'drop'|'hoop'} written by the Electron main process — the "
                        "already-resolved type per SKU. This runner never re-interprets Category/Sub-Category.")
    p.add_argument("--processing-mode", choices=("automatic", "manual"), default="automatic",
                   help="Shared Automatic/Manual workflow abstraction (Phase 11.5C). No effect on Stud/Drop "
                        "(see module docstring); relevant from Phase 12D (Hoop) onward.")
    p.add_argument("--splits-file", default=None,
                   help="Phase 12E (Hoop Manual) — JSON sidecar {sku: normalized_x (0-1)} written by the "
                        "Electron main process from the batch's persisted config.hoopSplits. Omitted or "
                        "absent means no manual splits are available (fine for Automatic-only batches).")
    return p.parse_args()


def _load_metadata_sidecar(path: str) -> dict[str, str]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Metadata sidecar must be a JSON object, got {type(data).__name__}")
    return data


def _load_splits_sidecar(path: str | None) -> dict[str, float]:
    """Tolerant of a missing/omitted --splits-file — every non-Manual-Hoop
    caller never needed one before Phase 12E, so this must not become a
    startup failure for them. An unreadable *but explicitly passed* file is
    still a fatal startup error (same treatment as a bad --metadata-file),
    since that would silently strand every Manual-Hoop SKU as "no split"."""
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Splits sidecar must be a JSON object, got {type(data).__name__}")
    return data


def _expected_output_paths(input_path: Path, output_dir: Path) -> tuple[Path, Path, Path]:
    stem = input_path.stem
    return (
        output_dir / f"{stem};compare.png",
        output_dir / f"{stem};frontFullImage.png",
        output_dir / f"{stem};frontImage.png",
    )


def _process_stud_or_drop(img: Image.Image, earring_type: str, front_path: Path) -> dict:
    casting_region = CASTING_REGION_BY_TYPE[earring_type]
    settings = {**EARRING_SHADOW, "casting_region": casting_region} if casting_region is not None else EARRING_SHADOW
    shadowed = composite_with_shadow(img, settings)
    shadowed.save(front_path)
    return {"frontImage": str(front_path), "earringType": earring_type}


def _process_hoop(
    img: Image.Image,
    front_full_path: Path,
    front_path: Path,
    processing_mode: str,
    splits: dict[str, float],
    sku: str,
) -> dict:
    """Hoop's compositing deliberately does not go through
    composite_with_shadow() — that helper pads to a square working canvas
    for shadow headroom and (optionally) trims back, which can never
    guarantee frontImage's canvas matches compare's own non-square
    dimensions exactly. Hoop's alignment contract (Phase 12 Resolved
    Decision 4) outranks that headroom: create_drop_shadow() is called
    directly on a canvas already sized to the source image, with no padding
    and no trim, so frontImage's dimensions equal the input's by
    construction — accepting minor shadow edge-clipping in exchange for
    guaranteed alignment with frontFullImage and compare.

    Automatic and Manual (Phase 12E) diverge only in how the front/rear
    split's x-position is obtained — both then call
    hoop_mask.build_mask_from_split_x identically, so a manually-placed
    split renders with the exact same soft edge as an automatically-detected
    one (see hoop_mask.py's module docstring)."""
    arr = np.array(img)
    alpha = arr[:, :, 3]

    if processing_mode == "manual":
        if sku not in splits:
            raise ValueError(f"No manual split placed for hoop SKU {sku!r}.")
        # config.hoopSplits stores a normalized fraction of the full image's
        # own width (Phase 12E architecture) — denormalized here into the
        # same absolute-pixel space vertical_split_x already operates in, so
        # build_mask_from_split_x needs no knowledge of which mode produced
        # its input.
        split_x = float(splits[sku]) * img.width
        mask = build_mask_from_split_x(alpha, split_x)
        # A human placed this — no "low confidence" concept applies, same
        # convention as Ring & Bracelet's own Manual mode (runner.py,
        # RingBracelet) reporting detected=True unconditionally.
        detected = True
    else:
        mask, detected = generate_hoop_mask(alpha)

    masked_alpha = np.clip(alpha.astype(np.float32) * (1.0 - mask.astype(np.float32) / 255.0), 0, 255).astype(np.uint8)
    masked_arr = arr.copy()
    masked_arr[:, :, 3] = masked_alpha
    masked_img = Image.fromarray(masked_arr, mode="RGBA")

    # frontFullImage: an unmodified duplicate of compare (Phase 12
    # Architectural Rules), not the rear-masked image — retained whole for
    # downstream Virtual Try-On usage.
    img.save(front_full_path)

    settings = {**EARRING_SHADOW, "casting_region": HOOP_CASTING_REGION}
    shadow = create_drop_shadow(
        masked_img, settings,
        subject_left=0, subject_width=masked_img.width,
        subject_top=0, subject_height=masked_img.height,
    )
    front_image = Image.alpha_composite(shadow, masked_img)

    # Hard runtime assertion (Phase 12 Resolved Decision 4 / 12D
    # requirement): compare, frontFullImage, and frontImage must be
    # pixel-dimension-identical. True by construction here (create_drop_shadow
    # never changes dimensions, see shadow.py), but asserted explicitly as a
    # safety net against a future refactor silently breaking it — a failure
    # here becomes this image's per-image error, not a batch-fatal one (see
    # run_batch's exception handling).
    assert front_image.size == img.size, (
        f"Hoop dimension mismatch: compare/frontFullImage={img.size}, frontImage={front_image.size}"
    )
    front_image.save(front_path)

    return {
        "frontFullImage": str(front_full_path),
        "frontImage": str(front_path),
        "earringType": "hoop",
        "detected": bool(detected),
    }


def _process_one_image(
    input_path: Path,
    output_dir: Path,
    earring_type: str,
    processing_mode: str,
    splits: dict[str, float],
) -> dict:
    """Returns the fields to merge into a 'complete' event. Raises on
    failure (including an unresolved type, or a Hoop SKU with no manual
    split placed in Manual mode) — run_batch's own exception handling turns
    that into a per-image 'error' event rather than aborting the batch,
    which is what keeps a mixed-type sheet's stud/drop rows completing even
    though its hoop rows might fail."""
    img = Image.open(input_path).convert("RGBA")
    compare_path, front_full_path, front_path = _expected_output_paths(input_path, output_dir)

    # compare: the preprocessed image, unmodified — the immutable asset
    # every editing operation derives from (Phase 12 Architectural Rules).
    # Unconditional and product-agnostic: written before the type dispatch
    # below, so even a failing type/mode combination still gets its compare
    # asset (matches the pre-12D Hoop-not-yet-supported behavior).
    img.save(compare_path)

    if earring_type == "hoop":
        result = _process_hoop(img, front_full_path, front_path, processing_mode, splits, input_path.stem)
    elif earring_type in CASTING_REGION_BY_TYPE:
        result = _process_stud_or_drop(img, earring_type, front_path)
    else:
        raise ValueError(f"Unrecognized earring type: {earring_type!r}")

    return {"compare": str(compare_path), **result}


def main() -> int:
    args = _parse_args()
    cancel_event = threading.Event()
    rb.start_cancel_listener(cancel_event)

    input_dir, output_dir = rb.resolve_io_dirs(args.input_dir, args.output_dir)

    images = rb.discover_and_validate(input_dir, SUPPORTED_EXTENSIONS)
    if images is None:
        return 1

    try:
        sidecar = _load_metadata_sidecar(args.metadata_file)
    except Exception as exc:
        rb.emit({"type": "fatal", "error": f"Failed to read metadata sidecar: {exc}"})
        return 1

    try:
        splits = _load_splits_sidecar(args.splits_file)
    except Exception as exc:
        rb.emit({"type": "fatal", "error": f"Failed to read splits sidecar: {exc}"})
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    rb.emit_start(images)

    def process_one(index: int, total: int, input_path: Path) -> None:
        sku = input_path.stem
        earring_type = sidecar.get(sku)
        compare_path, front_full_path, front_path = _expected_output_paths(input_path, output_dir)

        # Idempotent reruns (Phase 11.5D/12A precedent) — a SKU whose full
        # expected output set already exists was already processed in a
        # previous run against this same output directory. Hoop's expected
        # set includes frontFullImage.png too (Phase 12D); a Hoop SKU that
        # errored (e.g. Manual mode before 12E) never wrote frontImage.png,
        # so it never satisfies this and keeps retrying on every rerun,
        # which is intentional — same as an unresolved SKU.
        required_paths = (compare_path, front_full_path, front_path) if earring_type == "hoop" else (compare_path, front_path)
        if all(p.exists() for p in required_paths):
            complete_fields = {
                "compare": str(compare_path),
                "frontImage": str(front_path),
                "earringType": earring_type or "unknown",
            }
            if earring_type == "hoop":
                complete_fields["frontFullImage"] = str(front_full_path)
                # Neutral placeholder on skip, not a re-derived value — same
                # accepted information loss as Ring & Bracelet's own skip
                # path (runner.py, Phase 11.5D) has for `detected`.
                complete_fields["detected"] = True
            rb.emit({
                "type": "complete",
                "index": index,
                "total": total,
                "image": input_path.name,
                "duration_ms": 0,
                **complete_fields,
            })
            return

        if earring_type is None:
            raise ValueError(f"No resolved earring type for SKU {sku!r} in the metadata sidecar.")

        stage = "hoop_mask" if earring_type == "hoop" else "shadow"
        rb.emit({"type": "progress", "index": index, "total": total,
                  "image": input_path.name, "stage": stage, "status": "start"})
        t0 = time.perf_counter()
        result = _process_one_image(input_path, output_dir, earring_type, args.processing_mode, splits)
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
