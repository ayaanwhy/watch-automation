#!/usr/bin/env python3
"""Build native-size review panels for benchmark correction labels.

The training cache is deliberately not the review surface.  This report shows
the source crop, the proposed ownership transfer, and the resulting front/back
partition at 4x nearest-neighbour zoom so an over-wide label is immediately
visible before it can influence a checkpoint.
"""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from benchmark.build_manual_review import dark_composite, labelled
from vto.post import decontaminate


def bounds_for(mask, padding=18):
    ys, xs = np.nonzero(mask > 0)
    if not len(xs):
        return 0, 0, mask.shape[1], mask.shape[0]
    return (max(0, int(xs.min()) - padding), max(0, int(ys.min()) - padding),
            min(mask.shape[1], int(xs.max()) + 1 + padding),
            min(mask.shape[0], int(ys.max()) + 1 + padding))


def crop(image, bounds):
    x0, y0, x1, y1 = bounds
    return image[y0:y1, x0:x1]


def fit(image, width=480, height=280, nearest=False):
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    canvas = np.full((height, width, 3), 31, np.uint8)
    h, w = image.shape[:2]
    scale = min(width / max(w, 1), (height - 28) / max(h, 1))
    resized = cv2.resize(
        image, (max(1, round(w * scale)), max(1, round(h * scale))),
        interpolation=cv2.INTER_NEAREST if nearest else
        (cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC))
    x = (width - resized.shape[1]) // 2
    y = 28 + (height - 28 - resized.shape[0]) // 2
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return canvas


def overlay(source, mask):
    result = source.copy()
    selected = mask > 0
    result[selected] = np.clip(
        result[selected].astype(np.float32) * 0.38 +
        np.array([25, 190, 255], np.float32) * 0.62,
        0, 255).astype(np.uint8)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--case", action="append", default=[])
    args = parser.parse_args()

    assets = Path(args.assets).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((assets / "manifest.json").read_text())
    requested = set(args.case)
    cases = [case for case in manifest["cases"]
             if not requested or case["id"] in requested]
    pages = []

    for case in cases:
        case_dir = assets / case["id"]
        source = cv2.imread(str(case_dir / "source.jpg"), cv2.IMREAD_COLOR)
        full = cv2.imread(str(case_dir / "full.png"), cv2.IMREAD_GRAYSCALE)
        back = cv2.imread(str(case_dir / "back.png"), cv2.IMREAD_GRAYSCALE)
        added = cv2.imread(str(case_dir / "added.png"), cv2.IMREAD_GRAYSCALE)
        if any(image is None for image in (source, full, back, added)):
            raise ValueError(f"missing assets for {case['id']}")
        foreground = decontaminate(source, full.astype(np.float32) / 255.0)
        front = cv2.bitwise_and(full, cv2.bitwise_not(back))
        bounds = bounds_for(added)
        panels = [
            labelled(fit(crop(source, bounds)), "source - native crop"),
            labelled(fit(crop(overlay(source, added), bounds)),
                     f"proposed rail ({int((added > 0).sum())} px)"),
            labelled(fit(crop(added, bounds), nearest=True), "label mask - 4x"),
            labelled(fit(crop(dark_composite(foreground, front), bounds)),
                     "resulting front"),
            labelled(fit(crop(dark_composite(foreground, back), bounds)),
                     "resulting back"),
        ]
        row = np.concatenate(panels, axis=1)
        path = output / f"{case['id']}.png"
        cv2.imwrite(str(path), row)
        pages.append({"id": case["id"], "file": path.name,
                      "added_pixels": int((added > 0).sum())})

    (output / "review.json").write_text(json.dumps({
        "version": manifest["version"], "assets": str(assets), "cases": pages
    }, indent=2) + "\n")
    print(output / "review.json")
    for page in pages:
        print(output / page["file"])


if __name__ == "__main__":
    main()
