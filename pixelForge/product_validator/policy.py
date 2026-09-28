"""Calibrated API decision policy with explicit correctable inputs.

The model predicts facts.  This module turns those probabilities into an
accepted/correctable/rejected/uncertain outcome without pretending a
borderline score is safe enough for a hard rejection.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .taxonomy import (ASSET_CLASSES, QUALITY_FLAGS, ROTATION_CLASSES,
                       VIEW_CLASSES)


CORRECTIONS = {
    "rotate_left": {"operation": "rotate_left", "degrees": 90},
    "rotate_right": {"operation": "rotate_right", "degrees": 90},
    "half_turn": {"operation": "half_turn", "degrees": 180},
}


@dataclass(frozen=True)
class Thresholds:
    accept: float = 0.95
    reject: float = 0.95
    quality_reject: float = 0.90

    def __post_init__(self):
        for name, value in asdict(self).items():
            if not 0.5 <= float(value) <= 1.0:
                raise ValueError(f"{name} must be between 0.5 and 1.0")


def _top(probabilities: dict[str, float], classes: tuple[str, ...]):
    missing = set(classes) - set(probabilities)
    if missing:
        raise ValueError(f"probabilities are missing classes: {sorted(missing)}")
    return max(classes, key=lambda name: float(probabilities[name]))


def _response(status, code, message, *, expected_asset, asset, asset_score,
              view, view_score, rotation, rotation_score, suitable_score,
              quality_flags, correction=None):
    response = {
        "status": status,
        "code": code,
        "message": message,
        "expected_asset": expected_asset,
        "detected": {
            "asset": asset,
            "asset_confidence": round(float(asset_score), 6),
            "view": view,
            "view_confidence": round(float(view_score), 6),
            "rotation": rotation,
            "rotation_confidence": round(float(rotation_score), 6),
            "suitable_confidence": round(float(suitable_score), 6),
            "quality_flags": quality_flags,
        },
    }
    if correction is not None:
        response["correction"] = correction
    return response


def decide(probabilities: dict, expected_asset: str,
           thresholds: Thresholds | None = None) -> dict:
    """Return an API-safe accepted/correctable/rejected/uncertain decision."""
    if expected_asset not in ("ring", "gemstone"):
        raise ValueError("expected_asset must be ring or gemstone")
    thresholds = thresholds or Thresholds()
    assets = probabilities["asset"]
    views = probabilities["view"]
    rotations = probabilities["rotation"]
    quality = probabilities["quality"]
    if set(rotations) != set(ROTATION_CLASSES):
        raise ValueError("rotation probabilities do not match the taxonomy")
    if set(quality) != set(QUALITY_FLAGS):
        raise ValueError("quality probabilities do not match the taxonomy")
    asset = _top(assets, ASSET_CLASSES)
    view = _top(views, VIEW_CLASSES)
    rotation = _top(rotations, ROTATION_CLASSES)
    asset_score = float(assets[asset])
    view_score = float(views[view])
    rotation_score = float(rotations[rotation])
    suitable_score = float(probabilities["suitable"])
    flagged = sorted(
        (name, round(float(score), 6))
        for name, score in quality.items()
        if float(score) >= thresholds.quality_reject)

    args = dict(expected_asset=expected_asset, asset=asset,
                asset_score=asset_score, view=view, view_score=view_score,
                rotation=rotation, rotation_score=rotation_score,
                suitable_score=suitable_score, quality_flags=flagged)
    if asset == "other" and asset_score >= thresholds.reject:
        return _response("rejected", "unsupported_product",
                         "Upload a ring or one loose gemstone.", **args)
    if asset != expected_asset and asset_score >= thresholds.reject:
        human = "ring" if expected_asset == "ring" else "loose gemstone"
        return _response("rejected", "asset_type_mismatch",
                         f"Upload a {human} image for this request.", **args)
    if view != "front" and view_score >= thresholds.reject:
        human = "ring" if expected_asset == "ring" else "gemstone"
        return _response("rejected", "unsupported_view",
                         f"Upload a front-facing {human} image.", **args)
    if suitable_score <= 1.0 - thresholds.reject:
        return _response("rejected", "invalid_product_image",
                         "The product is not sufficiently visible for segmentation.",
                         **args)
    if flagged:
        return _response("rejected", "invalid_product_image",
                         "The image is not suitable for reliable segmentation.",
                         **args)

    expected_score = float(assets[expected_asset])
    clear_quality = all(float(score) <= 1.0 - thresholds.accept
                        for score in quality.values())
    common_accept = (
        expected_score >= thresholds.accept and
        float(views["front"]) >= thresholds.accept and
        suitable_score >= thresholds.accept and clear_quality)
    if (rotation != "none" and rotation_score >= thresholds.accept and
            common_accept):
        return _response(
            "correctable", "orientation_correction_required",
            "Product accepted after applying the orientation correction.",
            correction=CORRECTIONS[rotation], **args)
    if (common_accept and
            float(rotations["none"]) >= thresholds.accept):
        return _response("accepted", "valid_product", "Product image accepted.",
                         **args)
    return _response(
        "uncertain", "validation_uncertain",
        "The product or camera angle could not be validated confidently.", **args)
