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
  3 — cancelled cooperatively at a safe checkpoint (see Cancellation below)

Cancellation:
Electron requests cancellation by writing a single JSON line to this
process's stdin: {"cmd":"cancel"}. A background thread reads stdin and
sets an in-memory threading.Event when it sees that command; it emits
{"type":"cancel_requested"} immediately, but never acts on the request
itself. The main thread only checks the event at safe checkpoints —
before starting the next image, and between pipeline stages — never
while BiRefNet or SAM 2 inference is in progress. This avoids tearing
down the process mid-GPU-kernel on the MPS backend, which has been
observed to cause kernel panics when done via external SIGTERM/SIGKILL.
The process always exits on its own; Electron never sends a signal for
normal user cancellation.

Initialization visibility:
Before the first checkpoint can run, two one-time model loads happen:
BiRefNet (always, eagerly, before the per-image loop) and SAM 2 (lazily,
inside the first image's "sam" stage — see services/sam_segmenter.py).
Both are announced via {"type":"initializing","stage":"loading_birefnet"}
and {"type":"initializing","stage":"loading_sam2"} purely so the renderer
can tell the user these spans cannot be interrupted. Neither emit adds,
removes, or moves a cancellation checkpoint.
"""
from __future__ import annotations

import argparse
import atexit
import contextlib
from datetime import datetime
import json
import sys
import threading
import time
from pathlib import Path

# Ensure the project root is on sys.path regardless of how Electron invokes us.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

EXIT_CANCELLED = 3


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


# ── Cooperative cancellation ──────────────────────────────────────────────────
#
# _CANCEL_EVENT is set by a background stdin-reader thread the instant Electron
# sends {"cmd":"cancel"}. The main thread never reacts to it directly — it only
# checks the event at the safe checkpoints in main()'s per-image loop (top of
# loop, and between each pipeline stage). This guarantees the process never
# tears down while BiRefNet or SAM 2 is mid-inference on the MPS backend.
#
_CANCEL_EVENT = threading.Event()


# ── Profiling helpers ─────────────────────────────────────────────────────────

try:
    import psutil as _psutil
    _PSUTIL_PROC = _psutil.Process()
    def _rss_mb() -> float:
        return _PSUTIL_PROC.memory_info().rss / 1_048_576
except ImportError:
    def _rss_mb() -> float:  # type: ignore[misc]
        return 0.0

def _mps_stats() -> dict | None:
    try:
        import torch
        if not (hasattr(torch, 'mps') and torch.backends.mps.is_available()):
            return None
        return {
            "current_mb": round(torch.mps.current_allocated_memory() / 1_048_576, 1),
            "driver_mb":  round(torch.mps.driver_allocated_memory()  / 1_048_576, 1),
        }
    except Exception:
        return None

def _mean(vals: list) -> float:
    return sum(vals) / len(vals) if vals else 0.0

def _median(vals: list) -> float:
    s = sorted(vals)
    return s[len(s) // 2] if s else 0.0


def _stdin_listener() -> None:
    """Background daemon thread: read NDJSON commands from stdin.

    Only sets _CANCEL_EVENT and emits an acknowledgement — never exits the
    process. Runs for the lifetime of the process; ends naturally when stdin
    closes (Electron tears down the pipe) or the process exits.
    """
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
    # SAM tuning — renderer-controlled overrides for benchmarking.
    # When absent, config.py SAM defaults apply unchanged.
    p.add_argument("--sam-points-per-side", type=int, default=None,
                   help="Grid density: n×n prompt points (default from config.py).")
    p.add_argument("--sam-points-per-batch", type=int, default=None,
                   help="Points processed per decoder call (default from config.py).")
    p.add_argument("--sam-pred-iou-thresh", type=float, default=None,
                   help="Mask quality filter threshold in [0,1] (default from config.py).")
    p.add_argument("--sam-stability-score-thresh", type=float, default=None,
                   help="Mask boundary stability filter in [0,1] (default from config.py).")
    p.add_argument("--sam-max-masks", type=int, default=None,
                   help="Maximum masks to return after sorting by area (default from config.py).")
    p.add_argument("--sam-multimask-output", type=int, choices=[0, 1], default=None,
                   help="SAM2 multimask output: 1=enabled (SAM2 default), 0=disabled.")
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

    # Start listening for cancellation requests as early as possible so a
    # cancel sent during model loading is captured before the first checkpoint.
    threading.Thread(target=_stdin_listener, daemon=True).start()

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

    # Access the (possibly patched) SAM config for diagnostics.
    import config as _cfg
    sam_cfg = _cfg.SAM

    # ── Profiling output file ─────────────────────────────────────────────────
    # Written in line-buffered mode so every section is visible on disk
    # progressively — useful when reading the file while a long batch runs.
    _profile_dir = _HERE / "profiling"
    _profile_dir.mkdir(exist_ok=True)
    _ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    _profile_path = _profile_dir / f"profile_{_ts}.txt"
    _profile_file = open(_profile_path, "w", encoding="utf-8", buffering=1)
    atexit.register(_profile_file.close)   # closed regardless of which return path is taken

    def _plog(msg: str) -> None:
        print(msg, file=sys.stderr)
        print(msg, file=_profile_file)

    _profile_file.write(
        f"[PROFILE] Preprocessing run\n"
        f"  started      : {datetime.now().isoformat()}\n"
        f"  input_dir    : {input_dir}\n"
        f"  output_dir   : {output_dir}\n"
        f"  images       : {len(images)}\n"
        f"  scale_factor : {args.scale_factor}\n"
        f"  object_type  : {args.object_type}\n"
        f"  background   : {args.background}\n"
        f"  edge_mode    : {args.edge_mode}\n\n"
    )

    # ── Lazy service imports — must come after _patch_config_if_needed ────────
    from stage0.background_remover import BackgroundRemover
    from services.upscaler import upscale_image, get_last_upscale_diag
    from services.sam_segmenter import segment_image
    from services.plugin_loader import process_with_plugin

    # ── Prepare output directory tree ─────────────────────────────────────────
    temp_dir = output_dir / "temp"
    for d in (output_dir, temp_dir):
        d.mkdir(parents=True, exist_ok=True)

    # ── Resolve BiRefNet model root ───────────────────────────────────────────
    birefnet_root = (
        Path(args.birefnet_model_root).resolve()
        if args.birefnet_model_root
        else _HERE / "stage0" / "BiRefNet"
    )

    # ── Load models ───────────────────────────────────────────────────────────
    # No cancellation checkpoint exists here — this is the one genuinely
    # uninterruptible span in the pipeline (see "Initialization visibility"
    # above). The stage label is for renderer visibility only.
    emit({"type": "initializing", "stage": "loading_birefnet"})
    _birefnet_rss_before = _rss_mb()
    _birefnet_t0 = time.perf_counter()

    try:
        with _quiet():
            remover = BackgroundRemover(model_root=birefnet_root)
    except FileNotFoundError as exc:
        emit({"type": "fatal", "error": str(exc)})
        return 1
    except Exception as exc:
        emit({"type": "fatal", "error": f"Failed to load BiRefNet: {exc}"})
        return 1

    _birefnet_load_ms = int((time.perf_counter() - _birefnet_t0) * 1000)
    _birefnet_rss_after = _rss_mb()
    _plog(
        f"\n[PROFILE] BiRefNet init"
        f"\n  model_root : {birefnet_root}"
        f"\n  device     : {remover.device}"
        f"\n  input_res  : 1024×1024 (fixed resize in background_remover._preprocess)"
        f"\n  load_ms    : {_birefnet_load_ms:,}"
        f"\n  rss_before : {_birefnet_rss_before:.1f} MB"
        f"\n  rss_after  : {_birefnet_rss_after:.1f} MB"
        f"\n  rss_delta  : +{_birefnet_rss_after - _birefnet_rss_before:.1f} MB"
    )

    # ── Announce batch ────────────────────────────────────────────────────────
    total = len(images)
    emit({"type": "start", "total": total, "images": [p.name for p in images]})

    succeeded = 0
    failed = 0
    batch_t0 = time.perf_counter()
    ppi = (args.output_ppi, args.output_ppi)

    cancelled = False
    sam2_load_announced = False
    sam2_diag_printed = False
    upscale_diag_printed = False

    # Per-image profiling accumulators.
    image_records: list[dict] = []
    peak_rss = _birefnet_rss_after

    for index, input_path in enumerate(images, start=1):
        # Safe checkpoint — before starting the next image.
        if _CANCEL_EVENT.is_set():
            cancelled = True
            break

        image_t0 = time.perf_counter()
        temp_path = temp_dir / f"{input_path.stem}_upscaled.png"
        output_path = output_dir / f"{input_path.stem}{args.output_suffix}"
        timings: dict[str, int] = {}
        rss: dict[str, float] = {}

        try:
            # Safe checkpoint — before upscale.
            if _CANCEL_EVENT.is_set():
                cancelled = True
                break

            # Stage 1 — upscale (no-op copy when scale_factor == 1)
            rss["before_upscale"] = _rss_mb()
            with _stage(index, total, input_path.name, "upscale", timings):
                with _quiet():
                    upscaled_path = upscale_image(
                        str(input_path),
                        str(temp_path),
                        scale_factor=args.scale_factor,
                    )
            rss["after_upscale"] = _rss_mb()

            # Print Real-ESRGAN diagnostics once (first real upscale call only).
            if not upscale_diag_printed and args.scale_factor != 1:
                upscale_diag_printed = True
                _d = get_last_upscale_diag()
                if _d:
                    _plog(
                        f"\n[PROFILE] Real-ESRGAN diagnostics"
                        f"\n  version_torch      : {_d.get('version_torch', '?')}"
                        f"\n  version_realesrgan : {_d.get('version_realesrgan', '?')}"
                        f"\n  scale_factor       : {_d.get('scale_factor', '?')}"
                        f"\n  model_path         : {_d.get('model_path', '?')}"
                        f"\n  device_selected    : {_d.get('device_selected', '?')}"
                        f"\n  cuda_available     : {_d.get('cuda_available', '?')}"
                        f"\n  mps_available      : {_d.get('mps_available', '?')}"
                        f"\n  unexpected_cpu     : {_d.get('unexpected_cpu', '?')} "
                        +  ("← MPS is present but upscaler runs on CPU" if _d.get('unexpected_cpu') else "")
                        + f"\n  fp16_enabled       : {_d.get('fp16_enabled', '?')}"
                        f"\n  model_param_device : {_d.get('model_param_device', '?')}"
                        f"\n  model_param_dtype  : {_d.get('model_param_dtype', '?')}"
                        f"\n  tile_size          : {_d.get('tile_size', '?')}"
                        f"\n  cache_hit          : {_d.get('cache_hit', '?')}"
                        f"\n  input_shape        : {_d.get('input_shape', '?')} (H×W×C numpy BGR)"
                        f"\n  output_type        : {_d.get('output_type', '?')} (always CPU memory)"
                        f"\n  output_shape       : {_d.get('output_shape', '?')}"
                        f"\n  t_model_path_ms    : {_d.get('t_model_path_ms', '?')}"
                        f"\n  t_image_decode_ms  : {_d.get('t_image_decode_ms', '?')}"
                        f"\n  t_cache_lookup_ms  : {_d.get('t_cache_lookup_ms', '?')} "
                        + ("(cache hit — no rebuild)" if _d.get('cache_hit') else "(cache miss — model loaded from disk)")
                        + f"\n  t_enhance_ms       : {_d.get('t_enhance_ms', '?')} "
                        "(bundles: tensor prep + tiled forward passes + output conversion)"
                        f"\n  t_encode_ms        : {_d.get('t_encode_ms', '?')}"
                    )

            # Safe checkpoint — before BiRefNet.
            if _CANCEL_EVENT.is_set():
                cancelled = True
                break

            # Stage 2 — background removal via BiRefNet
            rss["before_birefnet"] = _rss_mb()
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
            rss["after_birefnet"] = _rss_mb()

            # Safe checkpoint — before SAM.
            if _CANCEL_EVENT.is_set():
                cancelled = True
                break

            # SAM 2 lazy-loads its model weights on first use (see
            # _load_generator in services/sam_segmenter.py). Announce that
            # one-time cost once, for renderer visibility only — this does
            # not change when or how SAM 2 loads, and the checkpoint above
            # is unchanged.
            if not sam2_load_announced:
                emit({"type": "initializing", "stage": "loading_sam2"})
                sam2_load_announced = True

            # Stage 3 — SAM 2 automatic segmentation
            # Resolve effective SAM params — CLI overrides take precedence over config.py.
            _sam_pps   = args.sam_points_per_side
            _sam_ppb   = args.sam_points_per_batch
            _sam_iou   = args.sam_pred_iou_thresh
            _sam_stab  = args.sam_stability_score_thresh
            _sam_mm    = (bool(args.sam_multimask_output) if args.sam_multimask_output is not None else None)
            _sam_maxm  = args.sam_max_masks

            _sam_rss_before = _rss_mb()
            _sam_t0 = time.perf_counter()
            rss["before_sam"] = _sam_rss_before
            with _stage(index, total, input_path.name, "sam", timings):
                with _quiet():
                    masks = segment_image(
                        rgba,
                        points_per_side=_sam_pps,
                        points_per_batch=_sam_ppb,
                        pred_iou_thresh=_sam_iou,
                        stability_score_thresh=_sam_stab,
                        max_masks=_sam_maxm,
                        multimask_output=_sam_mm,
                    )
            rss["after_sam"] = _rss_mb()

            # Print SAM 2 diagnostics once (after first load completes).
            if not sam2_diag_printed:
                sam2_diag_printed = True
                # Compute the effective resolution passed to SAM (mirrors
                # _resize_for_sam: longest side clamped to max_image_size).
                _w, _h = rgba.size
                _largest = max(_w, _h)
                if _largest <= sam_cfg.max_image_size:
                    _sam_w, _sam_h = _w, _h
                else:
                    _sc = sam_cfg.max_image_size / _largest
                    _sam_w = max(1, int(_w * _sc))
                    _sam_h = max(1, int(_h * _sc))
                # Derive device using the same priority order as _best_device().
                try:
                    import torch as _torch
                    _sam_dev = ("cuda" if _torch.cuda.is_available()
                                else "mps" if _torch.backends.mps.is_available()
                                else "cpu")
                except Exception:
                    _sam_dev = "unknown"
                _sam_first_ms = int((time.perf_counter() - _sam_t0) * 1000)
                # Effective values: override if provided, else config.py default.
                _eff_pps  = _sam_pps  if _sam_pps  is not None else sam_cfg.points_per_side
                _eff_ppb  = _sam_ppb  if _sam_ppb  is not None else sam_cfg.points_per_batch
                _eff_maxm = _sam_maxm if _sam_maxm is not None else sam_cfg.max_masks
                _eff_mm   = _sam_mm   if _sam_mm   is not None else True
                _grid_pts = _eff_pps ** 2
                _batches  = -(-_grid_pts // _eff_ppb)  # ceiling div
                _plog(
                    f"\n[PROFILE] SAM 2 init (first image includes model load)"
                    f"\n  checkpoint        : {sam_cfg.checkpoint}"
                    f"\n  device            : {_sam_dev}"
                    f"\n  points_per_side   : {_eff_pps}"
                    f"\n  points_per_batch  : {_eff_ppb}"
                    f"\n  grid_points_total : {_grid_pts}"
                    f"\n  forward_passes    : {_batches} per image"
                    f"\n  max_masks         : {_eff_maxm}"
                    f"\n  multimask_output  : {_eff_mm}"
                    f"\n  max_image_size    : {sam_cfg.max_image_size}"
                    f"\n  effective_res     : {_sam_w}×{_sam_h} (this image: {input_path.name})"
                    f"\n  first_sam_ms      : {_sam_first_ms:,} (includes model load)"
                    f"\n  rss_before        : {_sam_rss_before:.1f} MB"
                    f"\n  rss_after         : {rss['after_sam']:.1f} MB"
                    f"\n  rss_delta         : +{rss['after_sam'] - _sam_rss_before:.1f} MB"
                )

            # Safe checkpoint — before plugin.
            if _CANCEL_EVENT.is_set():
                cancelled = True
                break

            # Stage 4 — object-type plugin
            rss["before_plugin"] = _rss_mb()
            with _stage(index, total, input_path.name, "plugin", timings):
                with _quiet():
                    plugin_result = process_with_plugin(
                        rgba,
                        masks,
                        object_type=args.object_type,
                    )
            rss["after_plugin"] = _rss_mb()
            final_rgba = plugin_result.get("processed_image", rgba)

            # Safe checkpoint — before save.
            if _CANCEL_EVENT.is_set():
                cancelled = True
                break

            # Stage 5 — save the final processed image (the only output artefact)
            rss["before_save"] = _rss_mb()
            with _stage(index, total, input_path.name, "save", timings):
                final_rgba.save(output_path, dpi=ppi)
            rss["after_save"] = _rss_mb()

            duration_ms = int((time.perf_counter() - image_t0) * 1000)
            emit({
                "type": "complete",
                "index": index,
                "total": total,
                "image": input_path.name,
                "output": str(output_path),
                # Mask pixel data is in-memory only and scoped to the plugin
                # call above — it is never exported, so there is nothing to
                # report here. Kept as an empty list rather than removing
                # the key so the event shape is unchanged for any consumer.
                "masks": [],
                "duration_ms": duration_ms,
                "timings": timings,
            })
            succeeded += 1

            image_records.append({
                "image": input_path.name,
                "total_ms": duration_ms,
                "timings": dict(timings),
                "rss": dict(rss),
            })
            if rss:
                peak_rss = max(peak_rss, max(rss.values()))

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
            # Always clean up the temp upscaled file, even on failure or cancellation.
            if temp_path.exists():
                temp_path.unlink()

    total_ms = int((time.perf_counter() - batch_t0) * 1000)

    # ── Batch profiling summary ───────────────────────────────────────────────
    # Written to stderr so it lands in the Electron log without touching the
    # NDJSON stdout stream. Only printed when at least one image succeeded.
    if image_records:
        stages = ["upscale", "birefnet", "sam", "plugin", "save"]
        lines = ["\n[PROFILE] Batch summary", f"  images_profiled : {len(image_records)}"]

        # Stage timing table.
        lines.append(f"\n  {'stage':<12} {'avg_ms':>8} {'med_ms':>8} {'min_ms':>8} {'max_ms':>8}")
        lines.append(f"  {'-'*12} {'-'*8} {'-'*8} {'-'*8} {'-'*8}")
        for stage in stages:
            vals = [r["timings"][stage] for r in image_records if stage in r["timings"]]
            if vals:
                lines.append(
                    f"  {stage:<12} {_mean(vals):>8.0f} {_median(vals):>8.0f}"
                    f" {min(vals):>8} {max(vals):>8}"
                )

        # Per-image totals.
        totals = [r["total_ms"] for r in image_records]
        lines.append(f"\n  avg_total_ms  : {_mean(totals):.0f}")
        lines.append(f"  med_total_ms  : {_median(totals):.0f}")

        slowest = max(image_records, key=lambda r: r["total_ms"])
        fastest = min(image_records, key=lambda r: r["total_ms"])
        lines.append(f"  slowest_image : {slowest['image']} ({slowest['total_ms']:,} ms)")
        lines.append(f"  fastest_image : {fastest['image']} ({fastest['total_ms']:,} ms)")

        # Memory.
        lines.append(f"\n  peak_rss_mb   : {peak_rss:.1f}")
        mps = _mps_stats()
        if mps:
            lines.append(f"  mps_current_mb: {mps['current_mb']}")
            lines.append(f"  mps_driver_mb : {mps['driver_mb']}")

        # Stage RSS deltas (averaged across images).
        lines.append(f"\n  {'stage':<12} {'avg_rss_delta_mb':>18}")
        lines.append(f"  {'-'*12} {'-'*18}")
        for stage in stages:
            deltas = [
                r["rss"].get(f"after_{stage}", 0) - r["rss"].get(f"before_{stage}", 0)
                for r in image_records
                if f"before_{stage}" in r["rss"] and f"after_{stage}" in r["rss"]
            ]
            if deltas:
                lines.append(f"  {stage:<12} {_mean(deltas):>+18.1f}")

        lines.append(f"\n  total_batch_ms: {total_ms:,} ({total_ms/1000:.1f} s)")
        _plog("\n".join(lines))

        # ── Per-image detail table (file only — too verbose for stderr) ────────
        _detail: list[str] = [
            "\n[PROFILE] Per-image timings (ms)",
            f"  {'image':<30} {'total':>7} {'upscale':>8} {'birefnet':>9}"
            f" {'sam':>8} {'plugin':>7} {'save':>6}",
            f"  {'-'*30} {'-'*7} {'-'*8} {'-'*9} {'-'*8} {'-'*7} {'-'*6}",
        ]
        for rec in image_records:
            t = rec["timings"]
            _detail.append(
                f"  {rec['image']:<30} {rec['total_ms']:>7}"
                f" {t.get('upscale', '–'):>8} {t.get('birefnet', '–'):>9}"
                f" {t.get('sam', '–'):>8} {t.get('plugin', '–'):>7}"
                f" {t.get('save', '–'):>6}"
            )
        _detail += [
            "\n[PROFILE] Per-image RSS (MB)",
            f"  {'image':<30} {'before_bref':>11} {'after_bref':>10}"
            f" {'after_sam':>10} {'after_save':>10}",
            f"  {'-'*30} {'-'*11} {'-'*10} {'-'*10} {'-'*10}",
        ]
        for rec in image_records:
            r = rec["rss"]
            _detail.append(
                f"  {rec['image']:<30}"
                f" {r.get('before_birefnet', 0):>11.1f}"
                f" {r.get('after_birefnet', 0):>10.1f}"
                f" {r.get('after_sam', 0):>10.1f}"
                f" {r.get('after_save', 0):>10.1f}"
            )
        print("\n".join(_detail), file=_profile_file)

    print(f"\n[PROFILE] Report written: {_profile_path}", file=sys.stderr)

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
