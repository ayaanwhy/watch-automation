"""Visualize moving a thin central rear-mask bridge into the front layer."""

import argparse
from pathlib import Path

import cv2
import numpy as np

from vto.post import decontaminate


def repair(alpha, front, back, max_thickness=12):
    semantic = (back > 0.5).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(semantic, 8)
    if count <= 1:
        return front.copy(), back.copy(), np.zeros_like(semantic, bool)
    index = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    component = labels == index
    ys, xs = np.nonzero(component)
    left, right = int(xs.min()), int(xs.max())
    thickness = np.array([component[:, x].sum()
                          for x in range(left, right + 1)])
    span = len(thickness)
    eligible = thickness <= int(max_thickness)
    eligible[:span // 4] = False
    eligible[span - span // 4:] = False
    columns = np.flatnonzero(eligible)
    groups = np.split(columns, np.where(np.diff(columns) > 1)[0] + 1)

    result_front, result_back = front.copy(), back.copy()
    changed = np.zeros_like(component)
    for group in groups:
        if not len(group) or len(group) > max(4, int(round(span * 0.08))):
            continue
        before, after = int(group[0]) - 1, int(group[-1]) + 1
        if before < 0 or after >= span:
            continue
        if min(thickness[before], thickness[after]) <= 2 * int(max_thickness):
            continue
        anchor_left = float(np.flatnonzero(component[:, left + before]).min())
        anchor_right = float(np.flatnonzero(component[:, left + after]).min())
        peak = max(float(np.flatnonzero(component[:, left + int(offset)]).min())
                   for offset in group)
        baseline_mid = 0.5 * (anchor_left + anchor_right)
        depth = max(0.0, peak - baseline_mid)
        for position, offset in enumerate(group, start=1):
            x = left + int(offset)
            t = position / (len(group) + 1.0)
            baseline = anchor_left * (1.0 - t) + anchor_right * t
            desired_top = int(round(baseline + depth * np.sin(np.pi * t)))
            current_rows = np.flatnonzero(component[:, x])
            current_top = int(current_rows.min())
            y0, y1 = min(current_top, desired_top), max(current_top, desired_top)
            ownership = alpha[y0:y1 + 1, x] > 0.0
            rows = np.arange(y0, y1 + 1)
            to_back = ownership & (rows >= desired_top)
            to_front = ownership & (rows < desired_top)
            result_back[y0:y1 + 1, x][to_back] = alpha[y0:y1 + 1, x][to_back]
            result_front[y0:y1 + 1, x][to_back] = 0.0
            result_front[y0:y1 + 1, x][to_front] = alpha[y0:y1 + 1, x][to_front]
            result_back[y0:y1 + 1, x][to_front] = 0.0
            changed[y0:y1 + 1, x][ownership] = True
    return result_front, result_back, changed


def composite(foreground, alpha, background=36):
    a = alpha[..., None]
    canvas = np.full_like(foreground, int(background))
    return np.clip(foreground * a + canvas * (1.0 - a), 0, 255).astype(np.uint8)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("full")
    parser.add_argument("front")
    parser.add_argument("back")
    parser.add_argument("output")
    parser.add_argument("--max-thickness", type=int, default=12)
    args = parser.parse_args()

    bgr = cv2.imread(args.source, cv2.IMREAD_COLOR)
    masks = []
    for path in (args.full, args.front, args.back):
        raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        masks.append((raw if raw.ndim == 2 else raw[..., 3]).astype(np.float32) /
                     255.0)
    alpha, front, back = masks
    new_front, new_back, moved = repair(alpha, front, back,
                                        max_thickness=args.max_thickness)
    foreground = decontaminate(bgr, alpha)

    ys, xs = np.nonzero(alpha > 0.0)
    x0, x1 = max(int(xs.min()) - 15, 0), min(int(xs.max()) + 16, alpha.shape[1])
    # Tight vertical crop makes the central tip legible at native resolution.
    y0 = max(int(ys.min()) + int((ys.max() - ys.min()) * 0.55), 0)
    y1 = min(int(ys.max()) + 16, alpha.shape[0])
    panels = [
        composite(foreground, front)[y0:y1, x0:x1],
        composite(foreground, back)[y0:y1, x0:x1],
        composite(foreground, new_front)[y0:y1, x0:x1],
        composite(foreground, new_back)[y0:y1, x0:x1],
    ]
    labels = ["current front", "current back", "repaired front",
              f"repaired back; moved {int(moved.sum())} px"]
    header = 34
    height, width = panels[0].shape[:2]
    grid = np.full((height + header, width * len(panels), 3), 24, np.uint8)
    for index, (panel, label) in enumerate(zip(panels, labels)):
        x = index * width
        grid[header:, x:x + width] = panel
        cv2.putText(grid, label, (x + 8, 23), cv2.FONT_HERSHEY_SIMPLEX,
                    0.55, (225, 225, 225), 1, cv2.LINE_AA)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), grid)


if __name__ == "__main__":
    main()
