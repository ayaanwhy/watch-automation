#!/usr/bin/env python3
"""Generate SAM candidates for the two thin hidden shoulder rails.

This is an annotation helper, not part of deployment.  Tight boxes plus
positive/negative points let SAM trace a pale rail at native resolution; the
candidate is clipped to an existing full matte before it can become training
truth.
"""

import argparse
from pathlib import Path

import cv2
import numpy as np

from benchmark.build_manual_review import fit_tile, labelled
from segmentation.sam_utils import (get_device, load_predictor,
                                    set_image_with_fallback)


DEFAULT_BOX = np.array([0.300, 0.465, 0.415, 0.535], np.float32)
DEFAULT_POSITIVE = np.array([[0.350, 0.512], [0.382, 0.497]], np.float32)
DEFAULT_NEGATIVE = np.array([[0.345, 0.482], [0.350, 0.532],
                             [0.305, 0.500], [0.405, 0.478]], np.float32)


def side_prompt(width, height, side):
    box = DEFAULT_BOX.copy()
    positive = DEFAULT_POSITIVE.copy()
    negative = DEFAULT_NEGATIVE.copy()
    if side == "right":
        box[[0, 2]] = 1.0 - box[[2, 0]]
        positive[:, 0] = 1.0 - positive[:, 0]
        negative[:, 0] = 1.0 - negative[:, 0]
    scale = np.array([width, height], np.float32)
    return box * np.array([width, height, width, height], np.float32), \
        positive * scale, negative * scale


def overlay(source, mask, colour):
    result = source.copy()
    selected = mask > 0
    result[selected] = np.clip(0.35 * result[selected] + 0.65 * colour,
                               0, 255).astype(np.uint8)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--full", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--checkpoint", default="segmentation/sam_vit_b_01ec64.pth")
    parser.add_argument("--model-type", default="vit_b")
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "cuda"))
    args = parser.parse_args()

    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = cv2.imread(str(Path(args.source).resolve()), cv2.IMREAD_COLOR)
    full = cv2.imread(str(Path(args.full).resolve()), cv2.IMREAD_GRAYSCALE)
    if source is None or full is None or source.shape[:2] != full.shape:
        raise ValueError("source/full missing or shape mismatch")
    height, width = source.shape[:2]

    device = get_device(args.device, args.model_type)
    predictor = load_predictor(args.checkpoint, args.model_type, device)
    actual_device = set_image_with_fallback(
        predictor, cv2.cvtColor(source, cv2.COLOR_BGR2RGB))
    print(f"SAM {args.model_type} on {actual_device}")

    panels = []
    accepted = np.zeros((height, width), np.uint8)
    for side in ("left", "right"):
        box, positive, negative = side_prompt(width, height, side)
        points = np.concatenate((positive, negative), axis=0)
        labels = np.concatenate((np.ones(len(positive), np.int32),
                                 np.zeros(len(negative), np.int32)))
        candidates, scores, _ = predictor.predict(
            point_coords=points, point_labels=labels, box=box,
            multimask_output=True)
        debug = source.copy()
        x0, y0, x1, y1 = np.rint(box).astype(int)
        cv2.rectangle(debug, (x0, y0), (x1, y1), (0, 190, 255), 2)
        for point, label in zip(points.astype(int), labels):
            cv2.circle(debug, tuple(point), 5,
                       (60, 220, 60) if label else (60, 60, 240), -1)
        panels.append(labelled(fit_tile(debug, 420), f"{side} prompts"))

        ranked = []
        for index, (candidate, score) in enumerate(zip(candidates, scores)):
            clipped = candidate & (full > 3)
            area = int(clipped.sum())
            # Prefer a compact native structure, not the entire shank or head.
            box_area = max((x1 - x0) * (y1 - y0), 1)
            outside = int((candidate & ~((np.indices(candidate.shape)[1] >= x0) &
                                         (np.indices(candidate.shape)[1] <= x1) &
                                         (np.indices(candidate.shape)[0] >= y0) &
                                         (np.indices(candidate.shape)[0] <= y1))).sum())
            rank = float(score) - 2.0 * outside / box_area - abs(area - 1100) / 5000
            ranked.append((rank, index, clipped, area, float(score), outside))
            cv2.imwrite(str(output / f"{side}-candidate-{index}.png"),
                        candidate.astype(np.uint8) * 255)
            cv2.imwrite(str(output / f"{side}-candidate-{index}-clipped.png"),
                        clipped.astype(np.uint8) * 255)
            panels.append(labelled(
                fit_tile(overlay(source, clipped, np.array([40, 190, 255])), 420),
                f"{side} c{index} score={score:.3f} area={area}"))
        best = max(ranked, key=lambda item: item[0])
        _, index, clipped, area, score, outside = best
        accepted[clipped] = 255
        print(f"{side}: candidate={index} score={score:.4f} area={area} "
              f"outside_box={outside}")

    cv2.imwrite(str(output / "selected.png"), accepted)
    panels.append(labelled(fit_tile(overlay(
        source, accepted, np.array([40, 190, 255])), 420), "selected pair"))
    blank = np.full_like(panels[0], 31)
    while len(panels) % 4:
        panels.append(blank)
    sheet = np.concatenate([
        np.concatenate(panels[index:index + 4], axis=1)
        for index in range(0, len(panels), 4)
    ], axis=0)
    cv2.imwrite(str(output / "candidates.jpg"), sheet,
                [cv2.IMWRITE_JPEG_QUALITY, 97])
    print(output / "candidates.jpg")


if __name__ == "__main__":
    main()
