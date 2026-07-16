"""Optional object-segmentation helpers for hard studio cutouts.

Segmentation is used as an object-support mask, not as the final alpha. The
matting backend still supplies edge/detail information.
"""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class MaskCandidate:
    mask: np.ndarray
    score: float
    source_score: float | None = None
    meta: dict | None = None


def _installed(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def availability(config) -> list[dict]:
    ckpt = getattr(config, "SAM_HQ_CHECKPOINT", "")
    return [{
        "name": "sam_hq",
        "label": "SAM-HQ object support",
        "available": _installed("segment_anything") and bool(ckpt) and os.path.exists(ckpt),
        "requires": ["torch", "segment_anything", "SAM_HQ_CHECKPOINT"],
        "checkpoint": ckpt,
        "note": "Optional. Used by Segmented studio / jewellery profile.",
    }]


class SamHqSegmenter:
    name = "sam_hq"

    def __init__(self, checkpoint: str, model_type: str = "vit_b", device: str = "auto",
                 max_dim: int = 1600):
        import torch
        from segment_anything import SamPredictor, sam_model_registry

        if not checkpoint or not os.path.exists(checkpoint):
            raise FileNotFoundError("SAM_HQ_CHECKPOINT is missing")
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        if model_type not in sam_model_registry:
            raise ValueError(f"unknown SAM-HQ model type '{model_type}'")
        model = sam_model_registry[model_type](checkpoint=checkpoint)
        model.to(device=device)
        self._predictor = SamPredictor(model)
        self._device = device
        self._max_dim = max(512, int(max_dim or 1600))

    def segment(self, image_rgb: np.ndarray, prompts: dict) -> list[MaskCandidate]:
        h, w = image_rgb.shape[:2]
        scale = min(1.0, self._max_dim / float(max(h, w)))
        if scale < 1.0:
            work = cv2.resize(image_rgb, (int(round(w * scale)), int(round(h * scale))),
                              interpolation=cv2.INTER_AREA)
        else:
            work = image_rgb
        self._predictor.set_image(work)

        points = np.asarray(prompts.get("points") or [], dtype=np.float32)
        labels = np.asarray(prompts.get("labels") or [], dtype=np.int32)
        box = prompts.get("box")
        if scale != 1.0:
            if points.size:
                points *= scale
            if box is not None:
                box = (np.asarray(box, dtype=np.float32) * scale).astype(np.float32)
        if points.size == 0:
            points = None
            labels = None
        if box is not None:
            box = np.asarray(box, dtype=np.float32)

        try:
            masks, scores, _ = self._predictor.predict(
                point_coords=points,
                point_labels=labels,
                box=box,
                multimask_output=True,
                hq_token_only=False,
            )
        except TypeError:
            masks, scores, _ = self._predictor.predict(
                point_coords=points,
                point_labels=labels,
                box=box,
                multimask_output=True,
            )

        out: list[MaskCandidate] = []
        for mask, source_score in zip(masks, scores):
            m = mask.astype(np.uint8) * 255
            if scale != 1.0:
                m = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
            out.append(MaskCandidate(mask=m, score=0.0, source_score=float(source_score), meta={}))
        return out


def build(name: str, config):
    name = (name or "sam_hq").strip().lower()
    if name in ("", "none", "off"):
        return None
    if name == "sam_hq":
        return SamHqSegmenter(
            getattr(config, "SAM_HQ_CHECKPOINT", ""),
            getattr(config, "SAM_HQ_MODEL_TYPE", "vit_b"),
            getattr(config, "SEG_DEVICE", "auto"),
            getattr(config, "SEG_MAX_DIM", 1600),
        )
    raise ValueError(f"unknown segmentation model '{name}'")


def _sample_points(mask: np.ndarray, count: int, min_distance: int = 32) -> list[tuple[float, float]]:
    """Pick spaced points from a binary mask using a distance-transform center bias."""
    work = (mask > 0).astype(np.uint8)
    pts: list[tuple[float, float]] = []
    for _ in range(count):
        if work.max() == 0:
            break
        dist = cv2.distanceTransform(work, cv2.DIST_L2, 5)
        _, value, _, loc = cv2.minMaxLoc(dist)
        if value <= 0:
            break
        x, y = loc
        pts.append((float(x), float(y)))
        cv2.circle(work, (x, y), int(min_distance), 0, -1)
    return pts


def studio_prompts(image_rgb: np.ndarray, matte: np.ndarray) -> dict:
    """Generate automatic prompts for centered studio product images."""
    h, w = matte.shape[:2]
    rough = (matte > 120).astype(np.uint8) * 255
    ys, xs = np.where(rough > 0)
    if len(xs) == 0:
        return {"points": [], "labels": [], "box": [0, 0, w - 1, h - 1], "meta": {}}

    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    pad = int(round(0.04 * max(x1 - x0 + 1, y1 - y0 + 1)))
    box = [max(0, x0 - pad), max(0, y0 - pad), min(w - 1, x1 + pad), min(h - 1, y1 + pad)]

    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edge = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    edge = cv2.GaussianBlur(edge, (0, 0), 1.0)

    detail = ((matte > 150) & ((sat > 45) | (val < 190) | (edge > 16))).astype(np.uint8) * 255
    high = ((matte > 220) & ((sat > 32) | (edge > 10))).astype(np.uint8) * 255
    pos_mask = cv2.bitwise_or(detail, high)
    pos = _sample_points(pos_mask, 12, min_distance=max(20, int(max(h, w) * 0.025)))
    if not pos:
        pos = [(float(np.median(xs)), float(np.median(ys)))]

    yy = np.indices((h, w))[0]
    mid_y = int(np.percentile(ys, 55))
    pale_low_detail = ((matte > 100) & (sat < 45) & (val > 185) & (edge < 14))
    lower_reflection = pale_low_detail & (yy > mid_y)
    bright_inner_reflection = ((matte > 120) & (sat < 36) & (val > 202) & (edge < 10))
    reflection = (lower_reflection | bright_inner_reflection).astype(np.uint8) * 255
    neg = _sample_points(reflection, 10, min_distance=max(24, int(max(h, w) * 0.03)))

    border = max(8, int(round(max(h, w) * 0.025)))
    neg.extend([
        (float(border), float(border)),
        (float(w - border - 1), float(border)),
        (float(border), float(h - border - 1)),
        (float(w - border - 1), float(h - border - 1)),
        (float(w * 0.5), float(border)),
    ])

    points = pos + neg
    labels = [1] * len(pos) + [0] * len(neg)
    return {
        "points": points,
        "labels": labels,
        "box": box,
        "meta": {
            "positivePoints": len(pos),
            "negativePoints": len(neg),
            "box": box,
        },
    }


def reflection_candidate(image_rgb: np.ndarray, matte: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edge = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    edge = cv2.GaussianBlur(edge, (0, 0), 1.0)
    ys, _ = np.where(matte > 100)
    mid_y = int(np.percentile(ys, 55)) if len(ys) else matte.shape[0] // 2
    yy = np.indices(matte.shape)[0]
    pale_low_detail = ((matte > 100) & (sat < 45) & (val > 185) & (edge < 14))
    lower_reflection = pale_low_detail & (yy > mid_y)
    bright_inner_reflection = ((matte > 120) & (sat < 36) & (val > 202) & (edge < 10))
    return lower_reflection | bright_inner_reflection


def choose_mask(candidates: list[MaskCandidate], image_rgb: np.ndarray, matte: np.ndarray,
                prompts: dict) -> MaskCandidate | None:
    if not candidates:
        return None
    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edge = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    edge = cv2.GaussianBlur(edge, (0, 0), 1.0)

    core = (matte > 180) & ((sat > 45) | (val < 190) | (edge > 16))
    rough = matte > 120
    refl = reflection_candidate(image_rgb, matte)
    core_n = max(1, int(core.sum()))
    rough_n = max(1, int(rough.sum()))

    best = None
    for cand in candidates:
        mask = cand.mask > 0
        area = max(1, int(mask.sum()))
        core_hit = float((mask & core).sum()) / core_n
        rough_ratio = area / rough_n
        refl_ratio = float((mask & refl).sum()) / area
        source = cand.source_score if cand.source_score is not None else 0.0
        score = 2.4 * core_hit + 0.4 * source - 1.3 * refl_ratio - 0.55 * abs(rough_ratio - 1.0)
        # Never prefer a mask that solves reflection by dropping the product core.
        if core_hit < 0.72:
            score -= (0.72 - core_hit) * 5.0
        if rough_ratio < 0.55:
            score -= (0.55 - rough_ratio) * 2.5
        cand.score = float(score)
        cand.meta = {
            **(cand.meta or {}),
            "coreHit": round(core_hit, 4),
            "roughRatio": round(float(rough_ratio), 4),
            "reflectionRatio": round(refl_ratio, 4),
            "sourceScore": round(float(source), 4),
        }
        if best is None or cand.score > best.score:
            best = cand
    return best


def protect_detail_support(image_rgb: np.ndarray, matte: np.ndarray, support_mask: np.ndarray) -> np.ndarray:
    """Union segmentation support with high-confidence jewellery detail so
    conservative masks do not cut metal/charm connectors."""
    support = (support_mask > 0).astype(np.uint8) * 255
    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edge = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    edge = cv2.GaussianBlur(edge, (0, 0), 1.0)
    detail = ((matte > 170) & ((sat > 42) | (val < 190) | (edge > 15))).astype(np.uint8) * 255
    if detail.max() > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        detail = cv2.dilate(detail, k, iterations=1)
        support = cv2.bitwise_or(support, detail)
    return support


def fuse_support(matte: np.ndarray, support_mask: np.ndarray, expand: int = 5,
                 image_rgb: np.ndarray | None = None) -> np.ndarray:
    support = (support_mask > 0).astype(np.uint8) * 255
    if image_rgb is not None:
        support = protect_detail_support(image_rgb, matte, support)
    if expand > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (expand * 2 + 1, expand * 2 + 1))
        support = cv2.dilate(support, k, iterations=1)
    return np.where(support > 0, matte, 0).astype(np.uint8)
