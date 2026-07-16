import numpy as np


def compute_anchors(mask: np.ndarray, known_width_mm=None) -> dict:
    h, w = mask.shape[:2]
    binary = mask > 127
    ys, xs = np.where(binary)
    if len(xs) == 0:
        return {
            "anchor": {"x": 0.5, "y": 0.5},
            "bbox": None,
            "bboxWidthPx": 0,
            "pixelsPerMm": None,
            "imgWidth": int(w),
            "imgHeight": int(h),
        }

    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    bbox_w = x1 - x0 + 1
    bbox_h = y1 - y0 + 1

    ppm = None
    try:
        if known_width_mm and float(known_width_mm) > 0:
            ppm = bbox_w / float(known_width_mm)
    except (TypeError, ValueError):
        ppm = None

    return {
        "anchor": {"x": float(xs.mean()) / w, "y": float(ys.mean()) / h},
        "bbox": {"x": x0 / w, "y": y0 / h, "w": bbox_w / w, "h": bbox_h / h},
        "bboxWidthPx": int(bbox_w),
        "pixelsPerMm": ppm,
        "imgWidth": int(w),
        "imgHeight": int(h),
    }
