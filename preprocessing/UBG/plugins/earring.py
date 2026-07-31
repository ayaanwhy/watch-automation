from __future__ import annotations

from typing import Any


CONFIG = {
    # Phase 12A — trivial plugin, same shape as ring.py/bracelet.py: no
    # masking logic lives in Universal Preprocessing for Earring (the
    # dedicated Earring editing pipeline, preprocessing/Earring/, owns
    # Stud/Drop/Hoop-specific processing from Phase 12C onward). Explicit
    # False (rather than omitted) to make the no-SAM-cost intent visible
    # here rather than relying on plugin_loader's implicit default.
    "requires_masks": False,
    "export_masks": True,
    "export_parts": True,
}


def process(image, masks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "plugin": "earring",
        "config": CONFIG,
        "mask_count": len(masks),
        "masks": masks,
    }
