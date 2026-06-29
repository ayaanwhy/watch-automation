#!/usr/bin/env python3
"""
benchmark_sam.py — Compare SAM 2 points_per_side values.

Usage:
    python benchmark_sam.py                        # uses built-in synthetic watch image
    python benchmark_sam.py --image /path/to/watch.png

For each points_per_side candidate the script:
  • runs generator.generate() with a fresh generator (no singleton reuse)
  • records wall time, mask count, and largest-mask coverage
  • computes IoU of the primary (largest) mask against the reference run (32)

No existing configuration or defaults are changed.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

# ── project root on path ──────────────────────────────────────────────────────
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from config import SAM

# ── candidates ────────────────────────────────────────────────────────────────
CANDIDATES = [32, 24, 16, 12, 8]

# ── device ────────────────────────────────────────────────────────────────────

def _best_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ── synthetic watch image (used when no --image is supplied) ──────────────────

def _make_synthetic_watch(size: int = 1024) -> Image.Image:
    """
    Produces a grayscale-toned RGBA image that approximates the silhouette
    structure of a centred round watch photograph:
      • white background
      • dark oval case body
      • lighter dial face
      • two thin strap rectangles above and below
    """
    img = Image.new("RGB", (size, size), (240, 235, 230))
    draw = ImageDraw.Draw(img)
    cx, cy, r = size // 2, size // 2, int(size * 0.38)
    # strap (top)
    draw.rectangle([cx - 60, 0, cx + 60, cy - r + 20], fill=(50, 45, 40))
    # strap (bottom)
    draw.rectangle([cx - 60, cy + r - 20, cx + 60, size], fill=(50, 45, 40))
    # case bezel
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(30, 30, 35))
    # dial face (slightly smaller, lighter)
    dr = int(r * 0.82)
    draw.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=(200, 195, 185))
    # crown (small rectangle on the right side)
    draw.rectangle([cx + r - 4, cy - 18, cx + r + 18, cy + 18], fill=(60, 58, 55))
    print(f"  [synthetic] {size}×{size} px watch image created")
    return img


# ── image preparation (mirrors segment_image pre-processing) ─────────────────

def _prepare_rgb(image: Image.Image) -> tuple[Image.Image, float]:
    """Convert to RGB and resize to SAM.max_image_size if needed."""
    rgba = image.convert("RGBA")
    rgb = Image.alpha_composite(
        Image.new("RGBA", rgba.size, (255, 255, 255, 255)),
        rgba,
    ).convert("RGB")
    w, h = rgb.size
    largest = max(w, h)
    if largest <= SAM.max_image_size:
        return rgb, 1.0
    scale = SAM.max_image_size / largest
    resized = rgb.resize(
        (max(1, int(w * scale)), max(1, int(h * scale))), Image.BICUBIC
    )
    return resized, scale


# ── per-run SAM execution ─────────────────────────────────────────────────────

def _run_one(rgb_array: np.ndarray, points_per_side: int, device: str) -> dict:
    """
    Build a fresh generator with the given points_per_side, run generate(),
    and return timing + quality metrics.  The generator is discarded after
    each run so results are independent.
    """
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    from sam2.build_sam import build_sam2

    checkpoint_path = Path(SAM.checkpoint)
    if not checkpoint_path.is_absolute():
        checkpoint_path = _HERE / SAM.checkpoint
    if not checkpoint_path.exists():
        raise FileNotFoundError(
            f"SAM 2 checkpoint not found: {checkpoint_path}\n"
            "Run:  python download_models.py"
        )

    # Build model — time this separately (it is a one-time cost per process,
    # but we measure it here for completeness and exclude it from the comparison).
    t_load0 = time.perf_counter()
    model = build_sam2(SAM.model_config, str(checkpoint_path), device=device)
    generator = SAM2AutomaticMaskGenerator(
        model,
        points_per_side=points_per_side,
        points_per_batch=SAM.points_per_batch,
        pred_iou_thresh=SAM.pred_iou_thresh,
        stability_score_thresh=SAM.stability_score_thresh,
        min_mask_region_area=SAM.min_mask_region_area,
        output_mode="binary_mask",
    )
    load_ms = int((time.perf_counter() - t_load0) * 1000)

    # Inference — this is the number we are benchmarking.
    t0 = time.perf_counter()
    raw_masks = generator.generate(rgb_array)
    infer_ms = int((time.perf_counter() - t0) * 1000)

    # Sort by area descending (matches production code).
    sorted_masks = sorted(raw_masks, key=lambda m: m.get("area", 0), reverse=True)
    primary = sorted_masks[0] if sorted_masks else None

    total_pixels = rgb_array.shape[0] * rgb_array.shape[1]
    primary_coverage = (
        float(primary["area"]) / total_pixels * 100 if primary else 0.0
    )
    primary_iou_score = float(primary["predicted_iou"]) if primary else 0.0
    primary_stability = float(primary["stability_score"]) if primary else 0.0

    return {
        "points_per_side": points_per_side,
        "load_ms": load_ms,
        "infer_ms": infer_ms,
        "n_masks": len(sorted_masks),
        "primary_mask": primary["segmentation"] if primary else None,
        "primary_coverage_pct": primary_coverage,
        "primary_predicted_iou": primary_iou_score,
        "primary_stability": primary_stability,
    }


# ── IoU helper ────────────────────────────────────────────────────────────────

def _iou(a: np.ndarray | None, b: np.ndarray | None) -> float | None:
    if a is None or b is None:
        return None
    intersection = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(intersection / union) if union > 0 else 0.0


# ── table printer ─────────────────────────────────────────────────────────────

def _print_table(results: list[dict], reference_mask: np.ndarray | None) -> None:
    header = (
        f"{'pts/side':>8}  "
        f"{'infer (s)':>10}  "
        f"{'speedup':>8}  "
        f"{'masks':>6}  "
        f"{'coverage%':>10}  "
        f"{'pred_iou':>9}  "
        f"{'stability':>10}  "
        f"{'IoU vs 32':>10}"
    )
    sep = "─" * len(header)
    print()
    print(sep)
    print(header)
    print(sep)

    ref_ms = results[0]["infer_ms"]  # 32 is first

    for r in results:
        speedup = ref_ms / r["infer_ms"] if r["infer_ms"] > 0 else float("inf")
        iou_vs_ref = _iou(reference_mask, r["primary_mask"])
        iou_str = f"{iou_vs_ref:.3f}" if iou_vs_ref is not None else "  N/A"
        print(
            f"{r['points_per_side']:>8}  "
            f"{r['infer_ms']/1000:>10.2f}  "
            f"{speedup:>7.2f}×  "
            f"{r['n_masks']:>6}  "
            f"{r['primary_coverage_pct']:>10.1f}  "
            f"{r['primary_predicted_iou']:>9.3f}  "
            f"{r['primary_stability']:>10.3f}  "
            f"{iou_str:>10}"
        )

    print(sep)
    print()


# ── recommendation logic ──────────────────────────────────────────────────────

def _recommend(results: list[dict], reference_mask: np.ndarray | None) -> None:
    REF_IDX = 0  # results[0] is the 32-point reference
    ref = results[REF_IDX]

    print("RECOMMENDATION")
    print("──────────────")

    # Thresholds for "acceptable" quality vs reference:
    #   IoU ≥ 0.85  → primary mask is substantially the same region
    #   coverage within ±5pp of reference → watch body not badly cropped
    ref_coverage = ref["primary_coverage_pct"]
    best = None

    for r in results[1:]:  # skip the reference itself
        iou = _iou(reference_mask, r["primary_mask"])
        coverage_delta = abs(r["primary_coverage_pct"] - ref_coverage)
        if iou is not None and iou >= 0.85 and coverage_delta <= 5.0:
            best = r
        # stop at the first candidate that fails — we want the smallest
        # value that still passes, so we evaluate in descending order
        # (candidates are [32,24,16,12,8]; we skip 32 above)
        # actually we want the LOWEST passing value, so we keep scanning.

    if best is None:
        print(
            "No candidate below 32 meets the quality thresholds "
            "(IoU ≥ 0.85, coverage within ±5%). "
            "Recommend keeping points_per_side = 32."
        )
    else:
        speedup = ref["infer_ms"] / best["infer_ms"]
        iou = _iou(reference_mask, best["primary_mask"])
        print(
            f"Lowest points_per_side that preserves quality: {best['points_per_side']}\n"
            f"  IoU vs reference : {iou:.3f}\n"
            f"  Coverage delta   : {abs(best['primary_coverage_pct'] - ref_coverage):.1f}pp\n"
            f"  Speedup          : {speedup:.2f}×\n"
            f"\n"
            f"To apply, update config.py:\n"
            f"  points_per_side: int = {best['points_per_side']}"
        )
    print()


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description="Benchmark SAM 2 points_per_side values.")
    p.add_argument(
        "--image", default=None,
        help="Path to a watch PNG/JPEG to use as input. "
             "Omit to use the built-in synthetic watch image.",
    )
    args = p.parse_args()

    device = _best_device()
    print(f"\nDevice: {device.upper()}")

    if args.image:
        src = Image.open(args.image)
        print(f"Input : {args.image}  ({src.size[0]}×{src.size[1]} px)")
    else:
        print("Input : synthetic watch image (no --image supplied)")
        src = _make_synthetic_watch(size=1024)

    rgb, scale = _prepare_rgb(src)
    rgb_array = np.asarray(rgb).copy()
    print(f"SAM input size: {rgb.size[0]}×{rgb.size[1]} px  (scale={scale:.3f})\n")

    results = []
    for pts in CANDIDATES:
        print(f"Running points_per_side={pts} ...", end="", flush=True)
        result = _run_one(rgb_array, pts, device)
        results.append(result)
        print(f"  {result['infer_ms']/1000:.2f}s  →  {result['n_masks']} masks")

    reference_mask = results[0]["primary_mask"]  # 32-point primary mask

    _print_table(results, reference_mask)
    _recommend(results, reference_mask)

    return 0


if __name__ == "__main__":
    sys.exit(main())
