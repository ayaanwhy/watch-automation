from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image

from config import SAM


_GENERATOR = None
_GENERATOR_DEVICE = None


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


def _load_generator(device: str | None = None):
    global _GENERATOR, _GENERATOR_DEVICE
    selected_device = device or _best_device()
    if _GENERATOR is not None and _GENERATOR_DEVICE == selected_device:
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
        points_per_side=SAM.points_per_side,
        points_per_batch=SAM.points_per_batch,
        pred_iou_thresh=SAM.pred_iou_thresh,
        stability_score_thresh=SAM.stability_score_thresh,
        min_mask_region_area=SAM.min_mask_region_area,
        output_mode="binary_mask",
    )
    _GENERATOR_DEVICE = selected_device
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


def _generate_masks(rgb: Image.Image, device: str):
    generator = _load_generator(device)
    return generator.generate(np.asarray(rgb).copy())


def segment_image(image: Image.Image, *, artifact_name: str, output_dir: str | os.PathLike) -> list[dict[str, Any]]:
    print("Running SAM 2...", file=sys.stderr)
    rgba = image.convert("RGBA")
    rgb = Image.alpha_composite(
        Image.new("RGBA", rgba.size, (255, 255, 255, 255)),
        rgba,
    ).convert("RGB")
    sam_rgb, scale = _resize_for_sam(rgb)

    try:
        masks = _generate_masks(sam_rgb, _best_device())
    except torch.cuda.OutOfMemoryError:
        global _GENERATOR, _GENERATOR_DEVICE
        print("SAM 2 CUDA OOM; retrying on CPU.", file=sys.stderr)
        _GENERATOR = None
        _GENERATOR_DEVICE = None
        torch.cuda.empty_cache()
        masks = _generate_masks(sam_rgb, "cpu")
    masks = sorted(masks, key=lambda item: item.get("area", 0), reverse=True)[: SAM.max_masks]

    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    saved_masks: list[dict[str, Any]] = []
    for index, mask_data in enumerate(masks, start=1):
        mask_array = (mask_data["segmentation"].astype(np.uint8) * 255)
        mask_image = Image.fromarray(mask_array, mode="L")
        if scale != 1.0:
            mask_image = mask_image.resize(rgba.size, Image.NEAREST)
        mask_path = target_dir / f"{artifact_name}_mask_{index:02d}.png"
        mask_image.save(mask_path)
        bbox = [int(value / scale) for value in mask_data.get("bbox", [])] if scale != 1.0 else [
            int(value) for value in mask_data.get("bbox", [])
        ]
        saved_masks.append(
            {
                "index": index,
                "path": str(mask_path),
                "bbox": bbox,
                "area": int(mask_data.get("area", 0) / max(scale * scale, 1e-6)),
                "predicted_iou": float(mask_data.get("predicted_iou", 0.0)),
                "stability_score": float(mask_data.get("stability_score", 0.0)),
            }
        )

    print(f"SAM 2 complete. Saved {len(saved_masks)} mask(s).", file=sys.stderr)
    return saved_masks
