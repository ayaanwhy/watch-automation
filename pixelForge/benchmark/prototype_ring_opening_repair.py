"""Render bounded upper-opening repair prototypes for visual review.

This is a diagnostic companion to the configurator benchmark.  It operates on
an existing alpha mask and never changes the outer product silhouette: only an
enclosed finger opening can be reduced.
"""

import argparse
from pathlib import Path

import cv2
import numpy as np

from vto.post import antialias_subpixel, decontaminate


def repair_opening(alpha, window, max_depth):
    solid = np.asarray(alpha, np.float32) > 0.5
    background = (~solid).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(background, 8)
    height, width = solid.shape
    candidates = []
    for index in range(1, count):
        touches_border = (
            np.any(labels[0] == index) or np.any(labels[-1] == index) or
            np.any(labels[:, 0] == index) or np.any(labels[:, -1] == index)
        )
        if not touches_border:
            candidates.append(index)
    if not candidates:
        return alpha.copy(), np.zeros_like(solid)

    opening = max(candidates, key=lambda index: stats[index, cv2.CC_STAT_AREA])
    left, _, span, _ = map(int, stats[opening, :4])
    top = np.full(span, height, np.float32)
    for offset, x in enumerate(range(left, left + span)):
        rows = np.flatnonzero(labels[:, x] == opening)
        if len(rows):
            top[offset] = float(rows[0])

    valid = top < height
    known = np.flatnonzero(valid)
    if len(known) < 3:
        return alpha.copy(), np.zeros_like(solid)
    top = np.interp(np.arange(span), known, top[known]).astype(np.float32)
    kernel_width = min(int(window) | 1, span if span % 2 else span - 1)
    envelope = cv2.morphologyEx(
        top.reshape(1, -1), cv2.MORPH_CLOSE,
        np.ones((1, kernel_width), np.uint8)).reshape(-1)

    added = np.zeros_like(solid)
    for offset in range(span):
        depth = int(round(envelope[offset] - top[offset]))
        if depth <= 1 or depth > int(max_depth):
            continue
        x = left + offset
        y0, y1 = int(round(top[offset])), int(round(envelope[offset]))
        # Pixels must belong to this exact enclosed opening.  This prevents a
        # repair from crossing existing jewellery or affecting the exterior.
        rows = labels[y0:y1, x] == opening
        added[y0:y1, x][rows] = True

    repaired = np.asarray(alpha, np.float32).copy()
    repaired[added] = 1.0
    return repaired, added


def composite(bgr, alpha, background=36):
    matte = antialias_subpixel(alpha, sigma=0.6, edge_sigma=0.85)
    foreground = decontaminate(bgr, matte)
    a = matte[..., None]
    canvas = np.full_like(foreground, int(background))
    return np.clip(foreground * a + canvas * (1.0 - a), 0, 255).astype(np.uint8)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("mask")
    parser.add_argument("output")
    parser.add_argument("--windows", default="61,81,101")
    parser.add_argument("--max-depth", type=int, default=30)
    args = parser.parse_args()

    bgr = cv2.imread(args.source, cv2.IMREAD_COLOR)
    raw = cv2.imread(args.mask, cv2.IMREAD_UNCHANGED)
    if bgr is None or raw is None:
        raise SystemExit("could not read source or mask")
    alpha = (raw if raw.ndim == 2 else raw[..., 3]).astype(np.float32) / 255.0
    ys, xs = np.nonzero(alpha > 0.0)
    margin = 18
    x0, x1 = max(int(xs.min()) - margin, 0), min(int(xs.max()) + margin + 1,
                                                        alpha.shape[1])
    y0, y1 = max(int(ys.min()) - margin, 0), min(int(ys.max()) + margin + 1,
                                                        alpha.shape[0])

    panels = [composite(bgr, alpha)[y0:y1, x0:x1]]
    labels = ["current"]
    for value in args.windows.split(","):
        window = int(value)
        repaired, added = repair_opening(alpha, window, args.max_depth)
        panels.append(composite(bgr, repaired)[y0:y1, x0:x1])
        labels.append(f"window {window}; +{int(added.sum())} px")

    header = 34
    cell_width = max(panel.shape[1] for panel in panels)
    cell_height = max(panel.shape[0] for panel in panels)
    grid = np.full((cell_height + header, cell_width * len(panels), 3), 24,
                   np.uint8)
    for index, (panel, label) in enumerate(zip(panels, labels)):
        x = index * cell_width
        grid[header:header + panel.shape[0], x:x + panel.shape[1]] = panel
        cv2.putText(grid, label, (x + 8, 23), cv2.FONT_HERSHEY_SIMPLEX,
                    0.55, (225, 225, 225), 1, cv2.LINE_AA)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), grid)


if __name__ == "__main__":
    main()
