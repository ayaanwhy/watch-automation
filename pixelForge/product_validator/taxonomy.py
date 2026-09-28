"""Stable labels and manifest validation for product validation."""

from __future__ import annotations

from collections import Counter


SCHEMA_VERSION = 1
ASSET_CLASSES = ("ring", "gemstone", "other")
VIEW_CLASSES = ("front", "side", "angled", "rear")
ROTATION_CLASSES = ("none", "rotate_left", "rotate_right", "half_turn")
DECISION_SCHEMA_VERSION = 2
QUALITY_FLAGS = (
    "multiple_products",
    "occluded",
    "cropped",
    "low_quality",
    "lifestyle_image",
)

# These are data-readiness gates, not model acceptance thresholds.  They keep
# an apparently successful training run from being built on positives alone.
RECOMMENDED_MINIMUMS = {
    "asset:ring": 500,
    "asset:gemstone": 300,
    "asset:other": 500,
    "view:front": 500,
    "view:side": 200,
    "view:angled": 200,
    "view:rear": 100,
    "rotation:rotate_left": 20,
    "rotation:rotate_right": 20,
    "rotation:half_turn": 10,
    "suitable:true": 500,
    "suitable:false": 500,
    "quality:multiple_products": 100,
    "quality:occluded": 100,
    "quality:cropped": 100,
    "quality:low_quality": 100,
    "quality:lifestyle_image": 100,
}


def validate_labels(labels: dict) -> None:
    if not isinstance(labels, dict):
        raise ValueError("labels must be an object")
    asset = labels.get("asset")
    view = labels.get("view")
    rotation = labels.get("rotation")
    suitable = labels.get("suitable")
    quality = labels.get("quality")
    if asset is not None and asset not in ASSET_CLASSES:
        raise ValueError(f"unsupported asset label: {asset!r}")
    if view is not None and view not in VIEW_CLASSES:
        raise ValueError(f"unsupported view label: {view!r}")
    if rotation is not None and rotation not in ROTATION_CLASSES:
        raise ValueError(f"unsupported rotation label: {rotation!r}")
    if asset == "other" and rotation is not None:
        raise ValueError("other products cannot have a rotation label")
    if rotation not in (None, "none") and view != "front":
        raise ValueError("rotation correction requires a front camera view")
    if suitable is not None and not isinstance(suitable, bool):
        raise ValueError("suitable must be true, false or null")
    if quality is not None:
        if not isinstance(quality, list) or not all(
                isinstance(flag, str) for flag in quality):
            raise ValueError("quality must be a string list or null")
        unknown = sorted(set(quality) - set(QUALITY_FLAGS))
        if unknown:
            raise ValueError(f"unsupported quality flags: {unknown}")
        if len(quality) != len(set(quality)):
            raise ValueError("quality flags must be unique")


def validate_case(case: dict) -> None:
    required = ("id", "image", "sha256", "group_id", "source", "labels")
    missing = [field for field in required if field not in case]
    if missing:
        raise ValueError(f"case is missing fields: {missing}")
    for field in required[:-1]:
        if not isinstance(case[field], str) or not case[field].strip():
            raise ValueError(f"case {field} must be a non-empty string")
    digest = case["sha256"].lower()
    if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
        raise ValueError("case sha256 must be a lowercase hex digest")
    validate_labels(case["labels"])


def label_counts(cases: list[dict]) -> Counter:
    counts = Counter()
    for case in cases:
        labels = case["labels"]
        for field in ("asset", "view", "rotation"):
            value = labels.get(field)
            if value is not None:
                counts[f"{field}:{value}"] += 1
        suitable = labels.get("suitable")
        if suitable is not None:
            counts[f"suitable:{str(suitable).lower()}"] += 1
        quality = labels.get("quality")
        if quality is not None:
            counts["quality:known"] += 1
            for flag in quality:
                counts[f"quality:{flag}"] += 1
    return counts


def readiness(cases: list[dict]) -> dict:
    counts = label_counts(cases)
    shortages = {
        label: {"present": counts[label], "required": minimum,
                "missing": max(0, minimum - counts[label])}
        for label, minimum in RECOMMENDED_MINIMUMS.items()
        if counts[label] < minimum
    }
    return {
        "ready": not shortages,
        "case_count": len(cases),
        "group_count": len({case["group_id"] for case in cases}),
        "counts": dict(sorted(counts.items())),
        "shortages": shortages,
    }
