from __future__ import annotations

import importlib
from types import ModuleType
from typing import Any

from config import PIPELINE

# Phase 11D — every plugin under plugins/ is expected to expose exactly
# these two members (see plugins/generic.py, watch.py, bracelet.py,
# ring.py). Previously unenforced: a malformed plugin failed at call time
# with a raw AttributeError from inside process_with_plugin, or — for a
# missing CONFIG — failed silently, since electron_runner.py's own
# `getattr(_plugin, "CONFIG", {})` defaults quietly to an empty dict.
_REQUIRED_ATTRS = ("CONFIG", "process")


def _validate_plugin(module: ModuleType, safe_type: str) -> None:
    if not isinstance(getattr(module, "CONFIG", None), dict):
        raise ImportError(f"Plugin 'plugins.{safe_type}' is missing a required 'CONFIG' dict")
    if not callable(getattr(module, "process", None)):
        raise ImportError(f"Plugin 'plugins.{safe_type}' is missing a required 'process()' function")


def load_plugin(object_type: str | None = None):
    safe_type = "".join(
        ch.lower() if ch.isalnum() else "_" for ch in (object_type or PIPELINE.object_type)
    ).strip("_") or "generic"
    try:
        module = importlib.import_module(f"plugins.{safe_type}")
    except ModuleNotFoundError:
        module = importlib.import_module("plugins.generic")
        safe_type = "generic"
    _validate_plugin(module, safe_type)
    return module


def process_with_plugin(image, masks: list[dict[str, Any]], *, object_type: str | None = None):
    plugin = load_plugin(object_type)
    return plugin.process(image, masks)
