from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter

CONFIG = {
    "export_masks": True,
    "export_parts": True,
    "save_preview": True,
    # Edit this list to choose what gets removed from the watch image.
    # Use mask_index for precise selection, or region for a normalized box.
    # Example:
    # {"mask_index": 2}
    # {"region": [0.0, 0.0, 0.45, 1.0]}
    # {"pick": "smallest"}
    "remove_targets": [
         #{"mask_index": 2},
    ],
    # How much to expand the selected removal mask before cutting it out.
    "mask_expand_px": 15,
    # 0.0 means full removal strength. Higher values keep more of the part.
    "soft_removal_alpha": 0.0,
    "future_steps": [
        "strap_gap_cleanup",
        "bracelet_hole_cleanup",
        "edge_refinement",
        "part_extraction",
        "back_strap_gap_cleanup"
    ],
}


def _prepare_watch_context(image, masks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "image_size": image.size,
        "mask_count": len(masks),
        "masks": masks,
    }


def _load_mask(mask_path: str) -> Image.Image:
    return Image.open(mask_path).convert("L")


def _expand_mask(mask: Image.Image, px: int) -> Image.Image:
    if px <= 0:
        return mask
    return mask.filter(ImageFilter.MaxFilter(px * 2 + 1))


def _mask_from_region(size: tuple[int, int], region: list[float]) -> Image.Image:
    width, height = size
    x1 = max(0, min(width, int(region[0] * width)))
    y1 = max(0, min(height, int(region[1] * height)))
    x2 = max(0, min(width, int(region[2] * width)))
    y2 = max(0, min(height, int(region[3] * height)))
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle((x1, y1, x2, y2), fill=255)
    return mask


def _select_target_masks(image: Image.Image, masks: list[dict[str, Any]]) -> list[Image.Image]:
    selected: list[Image.Image] = []
    if not masks:
        return selected

    mask_by_index = {mask["index"]: _load_mask(mask["path"]) for mask in masks if mask.get("path")}
    sorted_masks = sorted(masks, key=lambda item: item.get("area", 0))

    for target in CONFIG.get("remove_targets", []):
        if not isinstance(target, dict):
            continue
        if "mask_index" in target and target["mask_index"] in mask_by_index:
            selected.append(mask_by_index[target["mask_index"]])
        elif "region" in target and isinstance(target["region"], list) and len(target["region"]) == 4:
            selected.append(_mask_from_region(image.size, target["region"]))
        elif target.get("pick") == "smallest" and sorted_masks:
            selected.append(_load_mask(sorted_masks[0]["path"]))
        elif target.get("pick") == "largest" and sorted_masks:
            selected.append(_load_mask(sorted_masks[-1]["path"]))

    return selected


def _combine_masks(size: tuple[int, int], masks: list[Image.Image]) -> Image.Image:
    combined = Image.new("L", size, 0)
    for mask in masks:
        combined = ImageChops.lighter(combined, mask.resize(size))
    return combined


def _remove_from_image(image: Image.Image, removal_mask: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    if CONFIG["soft_removal_alpha"] > 0:
        keep = Image.new("L", rgba.size, int(255 * CONFIG["soft_removal_alpha"]))
        removal_mask = ImageChops.lighter(removal_mask, keep)
    new_alpha = ImageChops.subtract(alpha, removal_mask)
    return Image.merge("RGBA", (*rgba.convert("RGB").split(), new_alpha))


def process(image, masks: list[dict[str, Any]]) -> dict[str, Any]:
    context = _prepare_watch_context(image, masks)
    selected_masks = _select_target_masks(image, masks)
    if selected_masks:
        combined_mask = _combine_masks(image.size, selected_masks)
        if CONFIG["mask_expand_px"] > 0:
            combined_mask = _expand_mask(combined_mask, int(CONFIG["mask_expand_px"]))
        processed_image = _remove_from_image(image, combined_mask)
    else:
        processed_image = image.convert("RGBA")
    return {
        "plugin": "watch",
        "config": CONFIG,
        "context": context,
        "processed_image": processed_image,
        "removed": bool(selected_masks),
        "selected_mask_count": len(selected_masks),
    }
