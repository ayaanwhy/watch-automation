#!/usr/bin/env python3
"""
electron_runner.py — Headless preprocessing engine for Electron integration.

All runtime configuration is accepted via CLI arguments; nothing is read from
config.py defaults at runtime (except SAM hyperparameters that have no CLI
equivalent, which remain at their config.py values).

Stdout protocol: every line is a JSON object (NDJSON).
All library output (print statements from BiRefNet / SAM / ESRGAN) is
redirected to stderr so stdout remains clean for JSON parsing.

Exit codes:
  0 — every image succeeded
  1 — fatal startup failure, or zero images succeeded
  2 — partial success (at least one image failed, at least one succeeded)
"""
from __future__ import annotations

import argparse
import contextlib
import json
import sys
import threading
import time
from pathlib import Path

# Ensure the project root is on sys.path regardless of how Electron invokes us.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


# ── JSON output ───────────────────────────────────────────────────────────────

def emit(event: dict) -> None:
    """Write one JSON event to the real stdout.

    Uses sys.__stdout__ directly so this is safe to call even while the
    _quiet() context manager has redirected sys.stdout to stderr, and safe
    to call from the heartbeat background thread.
    """
    print(json.dumps(event), file=sys.__stdout__, flush=True)


# ── Stdout suppressor ─────────────────────────────────────────────────────────

@contextlib.contextmanager
def _quiet():
    """Redirect sys.stdout → sys.stderr for the duration of a pipeline call.

    Prevents library print() statements (BiRefNet, SAM 2, Real-ESRGAN) from
    appearing on stdout and corrupting the JSON stream.
    """
    old = sys.stdout
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = old


# ── Stage timer with heartbeat ────────────────────────────────────────────────

_HEARTBEAT_INTERVAL_S = 2.0


@contextlib.contextmanager
def _stage(index: int, total: int, image: str, stage: str, timings: dict):
    """Instrument one pipeline stage with start/finish events and heartbeats.

    On enter  — emits {"type":"progress", ..., "status":"start"}.
    While running — a background daemon thread emits {"type":"heartbeat", ...}
                    every 2 seconds.  emit() writes to sys.__stdout__ directly
                    so heartbeats reach Electron even while _quiet() is active.
    On exit   — stops the heartbeat thread, records duration in timings, and
                emits {"type":"progress", ..., "status":"done", "duration_ms":N}.
    """
    t0 = time.perf_counter()
    emit({"type": "progress", "index": index, "total": total,
          "image": image, "stage": stage, "status": "start"})

    stop = threading.Event()

    def _heartbeat():
        while not stop.wait(_HEARTBEAT_INTERVAL_S):
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            emit({"type": "heartbeat", "image": image, "stage": stage,
                  "elapsed_ms": elapsed_ms})

    thread = threading.Thread(target=_heartbeat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join()
        duration_ms = int((time.perf_counter() - t0) * 1000)
        timings[stage] = duration_ms
        emit({"type": "progress", "index": index, "total": total,
              "image": image, "stage": stage, "status": "done",
              "duration_ms": duration_ms})


# ── CLI ───────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="electron_runner",
        description="Headless watch-image preprocessing engine.",
    )
    # Required
    p.add_argument("--input-dir", required=True,
                   help="Folder containing source images (.jpg/.jpeg/.png/.webp).")
    p.add_argument("--output-dir", required=True,
                   help="Folder for all output artefacts.")
    # Pipeline controls
    p.add_argument("--scale-factor", type=int, default=1, choices=[1, 2, 4],
                   help="Real-ESRGAN upscale factor (default: 1 = skip upscale).")
    p.add_argument("--object-type", default="watch",
                   help="Plugin to apply: watch, bracelet, ring, or generic.")
    p.add_argument("--background", default="Alpha",
                   help="Output background mode: 'Alpha' for transparency, or a hex color.")
    p.add_argument("--background-color", default="#ffffff",
                   help="Fill colour used when --background is not 'Alpha'.")
    p.add_argument("--output-ppi", type=int, default=300,
                   help="DPI value embedded in the output PNG metadata.")
    p.add_argument("--output-suffix", default=".png",
                   help="Output filename extension (.png or .webp).")
    p.add_argument("--refine-foreground", action="store_true", default=False,
                   help="Enable BiRefNet foreground refinement pass.")
    p.add_argument("--edge-mode", default="sharpen",
                   choices=["none", "sharpen", "soften"],
                   help="Edge finish applied after background removal.")
    p.add_argument("--edge-strength", type=float, default=1.0,
                   help="Strength of the edge finish (default: 1.0).")
    p.add_argument("--mask-blur", type=int, default=0,
                   help="Gaussian blur radius applied to the BiRefNet mask.")
    p.add_argument("--mask-offset", type=int, default=-2,
                   help="Mask erosion (negative) or dilation (positive) in pixels.")
    # Model paths — Electron always passes absolute paths so location is unambiguous
    p.add_argument("--birefnet-model-root", default=None,
                   help="Directory containing BiRefNet_dynamic.safetensors + birefnet.py. "
                        "Defaults to <script_dir>/stage0/BiRefNet.")
    p.add_argument("--sam-checkpoint", default=None,
                   help="Absolute path to sam2.1_hiera_tiny.pt. "
                        "Defaults to the path in config.py (models/sam2/...).")
    return p.parse_args()


# ── Config patching ───────────────────────────────────────────────────────────
#
# ARCHITECTURE NOTE — why this exists and why it is isolated here:
#
# sam_segmenter.py reads SAM.checkpoint from the config module at import time
# via `from config import SAM`, binding the name to the object that exists in
# config at that moment. To override the checkpoint path without modifying
# sam_segmenter.py, we replace config.SAM with a new frozen instance *before*
# sam_segmenter is imported.
#
# This pattern is used exactly once, in this function, before any service
# import occurs. It must never be replicated in the service modules themselves.
# Future work: if the services are refactored to accept dependency-injected
# config objects, this shim can be removed entirely.
#
def _patch_config_if_needed(args: argparse.Namespace) -> None:
    if args.sam_checkpoint is None:
        return  # nothing to patch; config.py default path applies

    import config
    from config import SamConfig

    existing = config.SAM
    config.SAM = SamConfig(
        # Override only the checkpoint path; all tuning parameters keep their
        # config.py values so callers can still adjust them there.
        checkpoint=args.sam_checkpoint,
        model_config=existing.model_config,
        max_image_size=existing.max_image_size,
        points_per_side=existing.points_per_side,
        points_per_batch=existing.points_per_batch,
        pred_iou_thresh=existing.pred_iou_thresh,
        stability_score_thresh=existing.stability_score_thresh,
        min_mask_region_area=existing.min_mask_region_area,
        max_masks=existing.max_masks,
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    args = _parse_args()

    # ── Validate inputs before touching any models ────────────────────────────
    input_dir = Path(args.input_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not input_dir.is_dir():
        emit({"type": "fatal", "error": f"Input directory not found: {input_dir}"})
        return 1

    images = sorted(
        p for p in input_dir.iterdir()
        if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    if not images:
        emit({"type": "fatal", "error": f"No supported images found in {input_dir}"})
        return 1

    # ── Patch config BEFORE importing any service modules ────────────────────
    _patch_config_if_needed(args)

    # ── Lazy service imports — must come after _patch_config_if_needed ────────
    from stage0.background_remover import BackgroundRemover
    from services.upscaler import upscale_image
    from services.sam_segmenter import segment_image
    from services.plugin_loader import process_with_plugin
    from services.preview import save_preview

    # ── Prepare output directory tree ─────────────────────────────────────────
    temp_dir = output_dir / "temp"
    masks_dir = output_dir / "masks"
    preview_dir = output_dir / "preview"
    png_dir = output_dir / "png"
    for d in (output_dir, temp_dir, masks_dir, preview_dir, png_dir):
        d.mkdir(parents=True, exist_ok=True)

    # ── Resolve BiRefNet model root ───────────────────────────────────────────
    birefnet_root = (
        Path(args.birefnet_model_root).resolve()
        if args.birefnet_model_root
        else _HERE / "stage0" / "BiRefNet"
    )

    # ── Load models ───────────────────────────────────────────────────────────
    emit({"type": "initializing", "stage": "loading_models"})

    try:
        with _quiet():
            remover = BackgroundRemover(model_root=birefnet_root)
    except FileNotFoundError as exc:
        emit({"type": "fatal", "error": str(exc)})
        return 1
    except Exception as exc:
        emit({"type": "fatal", "error": f"Failed to load BiRefNet: {exc}"})
        return 1

    # ── Announce batch ────────────────────────────────────────────────────────
    total = len(images)
    emit({"type": "start", "total": total, "images": [p.name for p in images]})

    succeeded = 0
    failed = 0
    batch_t0 = time.perf_counter()
    ppi = (args.output_ppi, args.output_ppi)

    for index, input_path in enumerate(images, start=1):
        image_t0 = time.perf_counter()
        temp_path = temp_dir / f"{input_path.stem}_upscaled.png"
        output_path = output_dir / f"{input_path.stem}{args.output_suffix}"
        timings: dict[str, int] = {}

        try:
            # Stage 1 — upscale (no-op copy when scale_factor == 1)
            with _stage(index, total, input_path.name, "upscale", timings):
                with _quiet():
                    upscaled_path = upscale_image(
                        str(input_path),
                        str(temp_path),
                        scale_factor=args.scale_factor,
                    )

            # Stage 2 — background removal via BiRefNet
            with _stage(index, total, input_path.name, "birefnet", timings):
                with _quiet():
                    rgba = remover.remove_background(
                        upscaled_path,
                        mask_blur=args.mask_blur,
                        mask_offset=args.mask_offset,
                        invert_output=False,
                        refine_foreground=args.refine_foreground,
                        edge_mode=args.edge_mode,
                        edge_strength=args.edge_strength,
                        background=args.background,
                        background_color=args.background_color,
                        artifact_name=input_path.stem,
                    )

            # Stage 3 — SAM 2 automatic segmentation
            with _stage(index, total, input_path.name, "sam", timings):
                with _quiet():
                    masks = segment_image(
                        rgba,
                        artifact_name=input_path.stem,
                        output_dir=masks_dir,
                    )

            # Stage 4 — object-type plugin
            with _stage(index, total, input_path.name, "plugin", timings):
                with _quiet():
                    plugin_result = process_with_plugin(
                        rgba,
                        masks,
                        object_type=args.object_type,
                    )
            final_rgba = plugin_result.get("processed_image", rgba)

            # Stage 5 — save all outputs
            with _stage(index, total, input_path.name, "save", timings):
                final_rgba.save(output_path, dpi=ppi)
                final_rgba.save(
                    png_dir / f"{input_path.stem}{args.output_suffix}", dpi=ppi
                )
                with _quiet():
                    save_preview(
                        input_path,
                        final_rgba,
                        masks,
                        preview_dir / f"{input_path.stem}_preview.png",
                    )

            duration_ms = int((time.perf_counter() - image_t0) * 1000)
            emit({
                "type": "complete",
                "index": index,
                "total": total,
                "image": input_path.name,
                "output": str(output_path),
                "masks": masks,
                "duration_ms": duration_ms,
                "timings": timings,
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

        finally:
            # Always clean up the temp upscaled file, even on failure.
            if temp_path.exists():
                temp_path.unlink()

    total_ms = int((time.perf_counter() - batch_t0) * 1000)
    emit({
        "type": "done",
        "succeeded": succeeded,
        "failed": failed,
        "total_duration_ms": total_ms,
    })

    if succeeded == 0:
        return 1
    if failed > 0:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
