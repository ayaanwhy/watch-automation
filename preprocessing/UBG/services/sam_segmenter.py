from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image

from config import SAM

# IMPORTANT:
#
# Do not resize the RGBA image before compositing onto white.
#
# Although this reduces PIL work, it produces a different RGB image
# for SAM2 that roughly doubles inference time on large (4×) inputs.
#
# See performance investigation July 2026.


_GENERATOR = None
# Cache key: (device, points_per_side, points_per_batch, pred_iou_thresh,
#              stability_score_thresh, multimask_output)
# Any change in params or device rebuilds the generator on the next call.
_GENERATOR_KEY: tuple | None = None


def _best_device() -> str:
    # Priority: CUDA (NVIDIA) → MPS (Apple Silicon) → CPU
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _resolve_path(path_value: str | os.PathLike) -> Path:
    path = Path(path_value).expanduser()
    if path.is_absolute():
        return path
    return _project_root() / path


def _load_generator(
    device: str | None = None,
    *,
    points_per_side: int | None = None,
    points_per_batch: int | None = None,
    pred_iou_thresh: float | None = None,
    stability_score_thresh: float | None = None,
    multimask_output: bool | None = None,
):
    global _GENERATOR, _GENERATOR_KEY
    selected_device = device or _best_device()

    # Resolve effective params — caller override takes precedence over config.SAM.
    eff_pps   = points_per_side         if points_per_side         is not None else SAM.points_per_side
    eff_ppb   = points_per_batch        if points_per_batch        is not None else SAM.points_per_batch
    eff_iou   = pred_iou_thresh         if pred_iou_thresh         is not None else SAM.pred_iou_thresh
    eff_stab  = stability_score_thresh  if stability_score_thresh  is not None else SAM.stability_score_thresh
    eff_mm    = multimask_output        if multimask_output        is not None else True  # SAM2 default

    key = (selected_device, eff_pps, eff_ppb, eff_iou, eff_stab, eff_mm)
    if _GENERATOR is not None and _GENERATOR_KEY == key:
        return _GENERATOR

    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    from sam2.build_sam import build_sam2

    checkpoint_path = _resolve_path(SAM.checkpoint)
    if not checkpoint_path.exists():
        raise FileNotFoundError(
            f"Missing SAM 2 checkpoint: {checkpoint_path}. Run python download_models.py once."
        )

    model = build_sam2(SAM.model_config, str(checkpoint_path), device=selected_device)
    _GENERATOR = SAM2AutomaticMaskGenerator(
        model,
        points_per_side=eff_pps,
        points_per_batch=eff_ppb,
        pred_iou_thresh=eff_iou,
        stability_score_thresh=eff_stab,
        min_mask_region_area=SAM.min_mask_region_area,
        output_mode="binary_mask",
        multimask_output=eff_mm,
    )
    _GENERATOR_KEY = key
    print(f"SAM 2 loaded on {selected_device.upper()}.", file=sys.stderr)
    return _GENERATOR


def _resize_for_sam(image: Image.Image) -> tuple[Image.Image, float]:
    width, height = image.size
    largest_side = max(width, height)
    if largest_side <= SAM.max_image_size:
        return image, 1.0
    scale = SAM.max_image_size / largest_side
    resized = image.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.BICUBIC)
    return resized, scale


def _generate_masks(rgb: Image.Image, device: str, **kwargs):
    generator = _load_generator(device, **kwargs)
    return generator.generate(np.asarray(rgb).copy())


def segment_image(
    image: Image.Image,
    *,
    points_per_side: int | None = None,
    points_per_batch: int | None = None,
    pred_iou_thresh: float | None = None,
    stability_score_thresh: float | None = None,
    max_masks: int | None = None,
    multimask_output: bool | None = None,
) -> list[dict[str, Any]]:
    print("Running SAM 2...", file=sys.stderr)
    rgba = image.convert("RGBA")
    rgb = Image.alpha_composite(
        Image.new("RGBA", rgba.size, (255, 255, 255, 255)),
        rgba,
    ).convert("RGB")
    sam_rgb, scale = _resize_for_sam(rgb)

    _sam_kwargs = dict(
        points_per_side=points_per_side,
        points_per_batch=points_per_batch,
        pred_iou_thresh=pred_iou_thresh,
        stability_score_thresh=stability_score_thresh,
        multimask_output=multimask_output,
    )
    try:
        masks = _generate_masks(sam_rgb, _best_device(), **_sam_kwargs)
    except torch.cuda.OutOfMemoryError:
        global _GENERATOR, _GENERATOR_KEY
        print("SAM 2 CUDA OOM; retrying on CPU.", file=sys.stderr)
        _GENERATOR = None
        _GENERATOR_KEY = None
        torch.cuda.empty_cache()
        masks = _generate_masks(sam_rgb, "cpu", **_sam_kwargs)
    eff_max_masks = max_masks if max_masks is not None else SAM.max_masks
    masks = sorted(masks, key=lambda item: item.get("area", 0), reverse=True)[: eff_max_masks]

    result_masks: list[dict[str, Any]] = []
    for index, mask_data in enumerate(masks, start=1):
        mask_array = (mask_data["segmentation"].astype(np.uint8) * 255)
        mask_image = Image.fromarray(mask_array, mode="L")
        if scale != 1.0:
            mask_image = mask_image.resize(rgba.size, Image.NEAREST)
        bbox = [int(value / scale) for value in mask_data.get("bbox", [])] if scale != 1.0 else [
            int(value) for value in mask_data.get("bbox", [])
        ]
        result_masks.append(
            {
                "index": index,
                # In-memory only — never written to disk. Stays alive only
                # for the duration of the object-type plugin call that
                # consumes it (see services/plugin_loader.py).
                "mask": mask_image,
                "bbox": bbox,
                "area": int(mask_data.get("area", 0) / max(scale * scale, 1e-6)),
                "predicted_iou": float(mask_data.get("predicted_iou", 0.0)),
                "stability_score": float(mask_data.get("stability_score", 0.0)),
            }
        )

    print(f"SAM 2 complete. Generated {len(result_masks)} mask(s).", file=sys.stderr)
    return result_masks
