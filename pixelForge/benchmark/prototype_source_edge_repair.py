"""Compare source-evidence contour recovery around a coarse ring matte."""

import argparse
from pathlib import Path

import cv2
import numpy as np

from vto.post import antialias_subpixel, decontaminate, estimate_background


def repair(alpha, bgr, radius, colour_tol, close_size):
    solid = np.asarray(alpha, np.float32) > 0.5
    near = cv2.dilate(
        solid.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * int(radius) + 1,) * 2)) > 0
    background = estimate_background(bgr)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg_lab = cv2.cvtColor(background.reshape(1, 1, 3).astype(np.uint8),
                          cv2.COLOR_BGR2LAB).astype(np.float32).reshape(3)
    distance = np.linalg.norm(lab - bg_lab[None, None, :], axis=2)
    background_mask = (~solid).astype(np.uint8)
    count, hole_labels, stats, _ = cv2.connectedComponentsWithStats(
        background_mask, 8)
    holes = [index for index in range(1, count)
             if not (np.any(hole_labels[0] == index) or
                     np.any(hole_labels[-1] == index) or
                     np.any(hole_labels[:, 0] == index) or
                     np.any(hole_labels[:, -1] == index))]
    region = np.zeros_like(solid)
    if holes:
        opening = max(holes, key=lambda index: stats[index, cv2.CC_STAT_AREA])
        ox, oy, ow, oh = map(int, stats[opening, :4])
        ys, xs = np.nonzero(solid)
        item_width = int(xs.max() - xs.min() + 1)
        centre = 0.5 * (float(xs.min()) + float(xs.max()))
        y0 = max(0, int(round(oy - 0.12 * item_width)))
        y1 = min(solid.shape[0], oy + 1)
        region[y0:y1] = True
        half_exclusion = 0.12 * item_width
        region[:, int(centre - half_exclusion):int(centre + half_exclusion + 1)] = False
    evidence = near & region & (distance >= float(colour_tol))
    seeded = solid | evidence
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                       (int(close_size), int(close_size)))
    closed = cv2.morphologyEx(seeded.astype(np.uint8), cv2.MORPH_CLOSE,
                              kernel) > 0
    component_count, component_labels = cv2.connectedComponents(
        closed.astype(np.uint8), 8)
    attached = np.unique(component_labels[solid])
    attached = attached[attached != 0]
    recovered = np.isin(component_labels, attached) & near & region
    result = np.asarray(alpha, np.float32).copy()
    result[recovered] = 1.0
    return result, (recovered & ~solid)


def checker(shape, size=12):
    y, x = np.indices(shape)
    values = np.where(((x // size + y // size) % 2)[..., None], 196, 235)
    return np.repeat(values.astype(np.uint8), 3, axis=2)


def composite(bgr, alpha, background):
    matte = antialias_subpixel(alpha, sigma=0.6, edge_sigma=0.85)
    foreground = decontaminate(bgr, matte)
    a = matte[..., None]
    return np.clip(foreground * a + background * (1.0 - a), 0, 255).astype(np.uint8)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("mask")
    parser.add_argument("output")
    parser.add_argument("--radius", type=int, default=12)
    parser.add_argument("--colour-tol", type=float, default=8)
    parser.add_argument("--close-sizes", default="5,7,9,11")
    args = parser.parse_args()
    bgr = cv2.imread(args.source, cv2.IMREAD_COLOR)
    raw = cv2.imread(args.mask, cv2.IMREAD_UNCHANGED)
    alpha = (raw if raw.ndim == 2 else raw[..., 3]).astype(np.float32) / 255.0
    backgrounds = [np.full_like(bgr, 31), checker(alpha.shape)]
    variants = [("current", alpha)]
    for value in args.close_sizes.split(","):
        size = int(value) | 1
        repaired, added = repair(alpha, bgr, args.radius, args.colour_tol, size)
        variants.append((f"close {size}; +{int(added.sum())}", repaired))

    crop = (120, 300, 880, 710)
    x0, y0, x1, y1 = crop
    rows = []
    for label, matte in variants:
        panels = [composite(bgr, matte, bg)[y0:y1, x0:x1]
                  for bg in backgrounds]
        row = np.concatenate(panels, axis=1)
        cv2.putText(row, label, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.65,
                    (40, 220, 80), 2, cv2.LINE_AA)
        rows.append(row)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), np.concatenate(rows, axis=0))


if __name__ == "__main__":
    main()
