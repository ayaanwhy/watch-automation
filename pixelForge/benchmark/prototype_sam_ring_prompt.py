"""Prompt SAM with the model ring and finger opening for mask diagnosis."""

import argparse
from pathlib import Path

import cv2
import numpy as np

from segmentation.sam_utils import load_predictor, set_image_with_fallback


def largest_enclosed(mask):
    background = (~mask).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(background, 8)
    candidates = []
    for index in range(1, count):
        touches = (np.any(labels[0] == index) or np.any(labels[-1] == index) or
                   np.any(labels[:, 0] == index) or np.any(labels[:, -1] == index))
        if not touches:
            candidates.append(index)
    if not candidates:
        return None
    index = max(candidates, key=lambda value: stats[value, cv2.CC_STAT_AREA])
    return labels == index


def sample_points(region, bins=5):
    ys, xs = np.nonzero(region)
    if not len(xs):
        return []
    points = []
    edges = np.linspace(xs.min(), xs.max() + 1, bins + 1).astype(int)
    distance = cv2.distanceTransform(region.astype(np.uint8), cv2.DIST_L2, 5)
    for left, right in zip(edges[:-1], edges[1:]):
        crop = distance[:, left:right]
        if crop.size and float(crop.max()) > 0:
            y, x = np.unravel_index(int(np.argmax(crop)), crop.shape)
            points.append((left + int(x), int(y)))
    return points


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("coarse_mask")
    parser.add_argument("output")
    parser.add_argument("--checkpoint",
                        default="segmentation/sam_vit_b_01ec64.pth")
    parser.add_argument("--model-type", default="vit_b")
    args = parser.parse_args()

    image = cv2.imread(args.source, cv2.IMREAD_COLOR)
    raw = cv2.imread(args.coarse_mask, cv2.IMREAD_UNCHANGED)
    coarse = (raw if raw.ndim == 2 else raw[..., 3]) > 127
    opening = largest_enclosed(coarse)
    if image is None or opening is None:
        raise SystemExit("source/mask missing or no enclosed opening")

    ys, xs = np.nonzero(coarse)
    box = np.array([xs.min() - 8, ys.min() - 8, xs.max() + 8, ys.max() + 8],
                   np.float32)
    box[[0, 2]] = np.clip(box[[0, 2]], 0, coarse.shape[1] - 1)
    box[[1, 3]] = np.clip(box[[1, 3]], 0, coarse.shape[0] - 1)
    positive = sample_points(coarse, bins=7)
    negative = sample_points(opening, bins=7)
    points = np.array(positive + negative, np.float32)
    labels = np.array([1] * len(positive) + [0] * len(negative), np.int32)

    predictor = load_predictor(args.checkpoint, args.model_type, "cuda")
    set_image_with_fallback(predictor, cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    masks, scores, _ = predictor.predict(
        point_coords=points, point_labels=labels, box=box[None, :],
        multimask_output=True)

    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    palette = [(80, 220, 80), (255, 160, 50), (80, 160, 255)]
    panels = []
    for index, (mask, score) in enumerate(zip(masks, scores)):
        cv2.imwrite(str(output / f"mask-{index}.png"), mask.astype(np.uint8) * 255)
        alpha = mask[..., None].astype(np.float32)
        panel = np.clip(image * alpha + 31 * (1.0 - alpha), 0, 255).astype(np.uint8)
        cv2.putText(panel, f"SAM {index} score {score:.4f}", (12, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.75, palette[index], 2, cv2.LINE_AA)
        panels.append(panel)
    preview = np.concatenate(panels, axis=1)
    cv2.imwrite(str(output / "preview.png"), preview)


if __name__ == "__main__":
    main()
