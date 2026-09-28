"""Native-resolution mask metrics used by label QA and editor agreement.

The functions in this module are deliberately independent of the v1 benchmark and
post-processing code.  They operate on alpha arrays in ``[0, 1]`` and categorical
ownership maps produced by :mod:`ring_v2.labels.audit`.
"""

from __future__ import annotations

from collections.abc import Iterable

import cv2
import numpy as np


EPSILON = 1e-8


def binary_boundary(mask: np.ndarray) -> np.ndarray:
    """Return the one-pixel inner boundary of a boolean mask."""
    mask_u8 = np.asarray(mask, dtype=np.uint8)
    if not np.any(mask_u8):
        return np.zeros_like(mask_u8, dtype=bool)
    eroded = cv2.erode(mask_u8, np.ones((3, 3), np.uint8), iterations=1)
    return (mask_u8 != 0) & (eroded == 0)


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return np.asarray(mask, dtype=bool).copy()
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    return cv2.dilate(np.asarray(mask, dtype=np.uint8), kernel) != 0


def boundary_f1(first: np.ndarray, second: np.ndarray, tolerance: int) -> float:
    """Symmetric boundary F score with a native-pixel tolerance."""
    first_edge = binary_boundary(first)
    second_edge = binary_boundary(second)
    first_count = int(first_edge.sum())
    second_count = int(second_edge.sum())
    if first_count == 0 and second_count == 0:
        return 1.0
    if first_count == 0 or second_count == 0:
        return 0.0
    first_match = first_edge & dilate(second_edge, tolerance)
    second_match = second_edge & dilate(first_edge, tolerance)
    precision = float(first_match.sum()) / first_count
    recall = float(second_match.sum()) / second_count
    return 2.0 * precision * recall / max(precision + recall, EPSILON)


def binary_iou(first: np.ndarray, second: np.ndarray) -> float:
    first = np.asarray(first, dtype=bool)
    second = np.asarray(second, dtype=bool)
    union = int(np.logical_or(first, second).sum())
    if union == 0:
        return 1.0
    return float(np.logical_and(first, second).sum()) / union


def component_areas(mask: np.ndarray) -> list[int]:
    count, _, stats, _ = cv2.connectedComponentsWithStats(
        np.asarray(mask, dtype=np.uint8), connectivity=8)
    return sorted(
        (int(value) for value in stats[1:count, cv2.CC_STAT_AREA]),
        reverse=True,
    )


def hole_areas(mask: np.ndarray) -> list[int]:
    """Areas of background components enclosed by the foreground."""
    inverse = ~np.asarray(mask, dtype=bool)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        inverse.astype(np.uint8), connectivity=8)
    holes: list[int] = []
    for index in range(1, count):
        component = labels == index
        if (np.any(component[0]) or np.any(component[-1]) or
                np.any(component[:, 0]) or np.any(component[:, -1])):
            continue
        holes.append(int(stats[index, cv2.CC_STAT_AREA]))
    return sorted(holes, reverse=True)


def thickness_summary(mask: np.ndarray) -> dict[str, int | float]:
    """Summarize local foreground diameter on the solid (alpha >= .5) mask."""
    solid = np.asarray(mask, dtype=np.uint8)
    if not np.any(solid):
        return {
            "pixels": 0,
            "thin_pixels_le_3": 0,
            "thin_fraction_le_3": 0.0,
            "diameter_le_1": 0,
            "diameter_le_2": 0,
            "diameter_le_3": 0,
            "diameter_le_5": 0,
            "diameter_gt_5": 0,
        }
    # OpenCV reports distance from pixel centre to the nearest background pixel.
    # Twice that distance is a stable native-pixel local-diameter proxy.
    diameter = 2.0 * cv2.distanceTransform(solid, cv2.DIST_L2, 5)[solid != 0]
    total = int(diameter.size)
    thin = int(np.count_nonzero(diameter <= 3.0))
    return {
        "pixels": total,
        "thin_pixels_le_3": thin,
        "thin_fraction_le_3": float(thin / total),
        "diameter_le_1": int(np.count_nonzero(diameter <= 1.0)),
        "diameter_le_2": int(np.count_nonzero(diameter <= 2.0)),
        "diameter_le_3": thin,
        "diameter_le_5": int(np.count_nonzero(diameter <= 5.0)),
        "diameter_gt_5": int(np.count_nonzero(diameter > 5.0)),
    }


def skeleton(mask: np.ndarray) -> np.ndarray:
    """Morphological skeleton without an optional scikit-image dependency."""
    current = np.asarray(mask, dtype=np.uint8).copy()
    result = np.zeros_like(current)
    kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    while np.any(current):
        opened = cv2.morphologyEx(current, cv2.MORPH_OPEN, kernel)
        result |= current & ~opened
        current = cv2.erode(current, kernel)
    return result != 0


def cldice(first: np.ndarray, second: np.ndarray) -> float:
    """Symmetric centreline Dice score for thin-structure connectivity."""
    first = np.asarray(first, dtype=bool)
    second = np.asarray(second, dtype=bool)
    first_skeleton = skeleton(first)
    second_skeleton = skeleton(second)
    first_count = int(first_skeleton.sum())
    second_count = int(second_skeleton.sum())
    if first_count == 0 and second_count == 0:
        return 1.0
    if first_count == 0 or second_count == 0:
        return 0.0
    topology_precision = float((first_skeleton & second).sum()) / first_count
    topology_recall = float((second_skeleton & first).sum()) / second_count
    return (2.0 * topology_precision * topology_recall /
            max(topology_precision + topology_recall, EPSILON))


def gradient_error(first: np.ndarray, second: np.ndarray,
                   region: np.ndarray | None = None) -> float:
    """Mean absolute Sobel-gradient difference, normalized to alpha units."""
    first = np.asarray(first, dtype=np.float32)
    second = np.asarray(second, dtype=np.float32)
    first_dx = cv2.Sobel(first, cv2.CV_32F, 1, 0, ksize=3) / 8.0
    first_dy = cv2.Sobel(first, cv2.CV_32F, 0, 1, ksize=3) / 8.0
    second_dx = cv2.Sobel(second, cv2.CV_32F, 1, 0, ksize=3) / 8.0
    second_dy = cv2.Sobel(second, cv2.CV_32F, 0, 1, ksize=3) / 8.0
    error = np.abs(first_dx - second_dx) + np.abs(first_dy - second_dy)
    if region is not None:
        region = np.asarray(region, dtype=bool)
        return float(error[region].mean()) if np.any(region) else 0.0
    return float(error.mean())


def connectivity_error(first: np.ndarray, second: np.ndarray,
                       step: float = 0.1) -> float:
    """Normalized alpha-matting connectivity error.

    This follows the standard threshold-sweep construction: at every threshold the
    largest connected component shared by both mattes is retained, and the level at
    which each pixel leaves that component forms the connectivity map.
    """
    first = np.asarray(first, dtype=np.float32)
    second = np.asarray(second, dtype=np.float32)
    level = np.full(first.shape, -1.0, np.float32)
    previous = np.zeros(first.shape, dtype=bool)
    thresholds = np.arange(0.0, 1.0 + step / 2.0, step, dtype=np.float32)
    for threshold in thresholds:
        intersection = (first >= threshold) & (second >= threshold)
        areas = component_areas(intersection)
        if areas:
            count, labels, stats, _ = cv2.connectedComponentsWithStats(
                intersection.astype(np.uint8), connectivity=8)
            largest = 1 + int(np.argmax(stats[1:count, cv2.CC_STAT_AREA]))
            current = labels == largest
        else:
            current = np.zeros_like(intersection)
        left = previous & ~current & (level < 0)
        level[left] = max(0.0, float(threshold - step))
        previous = current
    level[level < 0] = 1.0

    def phi(alpha: np.ndarray) -> np.ndarray:
        distance = alpha - level
        return np.where(distance >= 0.15, 1.0 - distance, 1.0)

    return float(np.abs(phi(first) - phi(second)).mean())


def thin_structure_recall(reference: np.ndarray, candidate: np.ndarray,
                          max_diameter: float = 3.0) -> float:
    reference = np.asarray(reference, dtype=bool)
    candidate = np.asarray(candidate, dtype=bool)
    if not np.any(reference):
        return 1.0
    diameter = 2.0 * cv2.distanceTransform(
        reference.astype(np.uint8), cv2.DIST_L2, 5)
    thin = reference & (diameter <= max_diameter)
    if not np.any(thin):
        return 1.0
    return float((thin & candidate).sum()) / int(thin.sum())


def aggregate(values: Iterable[float]) -> dict[str, float | int]:
    array = np.asarray(list(values), dtype=np.float64)
    if array.size == 0:
        return {"count": 0}
    return {
        "count": int(array.size),
        "mean": float(array.mean()),
        "median": float(np.median(array)),
        "std": float(array.std()),
        "min": float(array.min()),
        "p05": float(np.percentile(array, 5)),
        "p95": float(np.percentile(array, 95)),
        "max": float(array.max()),
    }
