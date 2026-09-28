#!/usr/bin/env python3
"""Compare native rail labels with baseline and candidate layer predictions."""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from benchmark.build_correction_label_review import bounds_for, crop, fit, overlay
from benchmark.build_manual_review import dark_composite, labelled


def alpha(path):
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] != 4:
        raise ValueError(f"missing RGBA prediction: {path}")
    return image, image[..., 3]


def panel(image, text, nearest=False):
    return labelled(fit(image, nearest=nearest), text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--case", action="append", default=[])
    args = parser.parse_args()

    assets = Path(args.assets).resolve()
    baseline = Path(args.baseline).resolve()
    candidate = Path(args.candidate).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((assets / "manifest.json").read_text())
    requested = set(args.case)
    metrics = []

    for case in manifest["cases"]:
        case_id = case["id"]
        if requested and case_id not in requested:
            continue
        case_assets = assets / case_id
        source = cv2.imread(str(case_assets / "source.jpg"), cv2.IMREAD_COLOR)
        target_added = cv2.imread(str(case_assets / "added.png"),
                                  cv2.IMREAD_GRAYSCALE) > 127
        target_back = cv2.imread(str(case_assets / "back.png"),
                                 cv2.IMREAD_GRAYSCALE) > 127
        base_rgba, base_back_u8 = alpha(baseline / case_id / "back.png")
        cand_rgba, cand_back_u8 = alpha(candidate / case_id / "back.png")
        _, base_front_u8 = alpha(baseline / case_id / "front.png")
        _, cand_front_u8 = alpha(candidate / case_id / "front.png")
        base_back = base_back_u8 > 127
        cand_back = cand_back_u8 > 127
        newly_back = cand_back & ~base_back
        allowed = cv2.dilate(target_added.astype(np.uint8),
                             np.ones((7, 7), np.uint8)) > 0
        target_pixels = max(int(target_added.sum()), 1)
        new_pixels = max(int(newly_back.sum()), 1)
        row = {
            "id": case_id,
            "target_added_pixels": int(target_added.sum()),
            "candidate_new_back_pixels": int(newly_back.sum()),
            "target_recall": round(float((cand_back & target_added).sum()) /
                                   target_pixels, 6),
            "new_back_precision_3px": round(float((newly_back & allowed).sum()) /
                                             new_pixels, 6),
            "new_back_outside_3px": int((newly_back & ~allowed).sum()),
            "corrected_back_iou": round(float((cand_back & target_back).sum()) /
                                        max(int((cand_back | target_back).sum()), 1), 6),
        }
        metrics.append(row)

        diagnostic = np.zeros(source.shape[:2] + (3,), np.uint8)
        diagnostic[newly_back] = (40, 190, 255)
        diagnostic[target_added & ~cand_back] = (65, 65, 255)
        bounds = bounds_for(target_added.astype(np.uint8), padding=24)
        panels = [
            panel(crop(source, bounds), "source - native crop"),
            panel(crop(overlay(source, target_added), bounds), "expected rail"),
            panel(crop(dark_composite(base_rgba[..., :3],
                                      base_front_u8), bounds),
                  "v6 front"),
            panel(crop(dark_composite(cand_rgba[..., :3],
                                      cand_front_u8), bounds),
                  "candidate front"),
            panel(crop(diagnostic, bounds),
                  f"amber new / red missed; recall {row['target_recall']:.3f}",
                  nearest=True),
            panel(crop(dark_composite(cand_rgba[..., :3],
                                      cand_back_u8), bounds),
                  "candidate back"),
        ]
        cv2.imwrite(str(output / f"{case_id}.png"), np.concatenate(panels, axis=1))

    summary = {
        "cases": len(metrics),
        "mean_target_recall": round(float(np.mean(
            [row["target_recall"] for row in metrics])), 6),
        "min_target_recall": round(float(np.min(
            [row["target_recall"] for row in metrics])), 6),
        "mean_new_back_precision_3px": round(float(np.mean(
            [row["new_back_precision_3px"] for row in metrics])), 6),
        "total_new_back_outside_3px": int(sum(
            row["new_back_outside_3px"] for row in metrics)),
    }
    (output / "review.json").write_text(json.dumps({
        "summary": summary, "cases": metrics
    }, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    print(output / "review.json")


if __name__ == "__main__":
    main()
