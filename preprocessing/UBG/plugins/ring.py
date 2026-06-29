from __future__ import annotations

from typing import Any


CONFIG = {
    "export_masks": True,
    "export_parts": True,
}


def process(image, masks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "plugin": "ring",
        "config": CONFIG,
        "mask_count": len(masks),
        "masks": masks,
    }
