from __future__ import annotations

import importlib
from typing import Any

from config import PIPELINE


def load_plugin(object_type: str | None = None):
    safe_type = "".join(
        ch.lower() if ch.isalnum() else "_" for ch in (object_type or PIPELINE.object_type)
    ).strip("_") or "generic"
    try:
        return importlib.import_module(f"plugins.{safe_type}")
    except ModuleNotFoundError:
        return importlib.import_module("plugins.generic")


def process_with_plugin(image, masks: list[dict[str, Any]], *, object_type: str | None = None):
    plugin = load_plugin(object_type)
    return plugin.process(image, masks)
