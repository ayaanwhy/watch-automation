#!/usr/bin/env python3
"""Build native-resolution before/after sheets for rejected review cases.

The normal manual viewer is optimized for making decisions.  This report is
optimized for diagnosing a failed candidate: it crops to the actual product,
puts the baseline and candidate ownership masks side-by-side, and records the
exact case order supplied by the review JSON.
"""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from benchmark.build_manual_review import dark_composite, labelled
from vto.post import decontaminate


LAYERS = ("full", "front", "back")


def read_report(path):
    report = json.loads(path.read_text())
    return report, {case["id"]: case for case in report["cases"]
                    if case.get("masks")}


def read_masks(root, case):
    masks = {}
    for layer in LAYERS:
        mask = cv2.imread(str(root / case["masks"][layer]),
                          cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise ValueError(f"missing {case['id']} {layer} mask")
        masks[layer] = mask
    return masks


def crop_bounds(mask, padding_fraction=0.06):
    ys, xs = np.nonzero(mask > 3)
    if not len(xs):
        return 0, 0, mask.shape[1], mask.shape[0]
    span = max(int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))
    pad = max(12, round(span * padding_fraction))
    return (max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
            min(mask.shape[1], int(xs.max()) + 1 + pad),
            min(mask.shape[0], int(ys.max()) + 1 + pad))


def crop(image, bounds):
    x0, y0, x1, y1 = bounds
    return image[y0:y1, x0:x1]


def tile(image, text, size):
    canvas = np.full((size, size, 3), 31, np.uint8)
    available = size - 32
    h, w = image.shape[:2]
    scale = min(size / max(w, 1), available / max(h, 1))
    resized = cv2.resize(
        image, (max(1, round(w * scale)), max(1, round(h * scale))),
        interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_NEAREST)
    y = 32 + max(0, (available - resized.shape[0]) // 2)
    x = max(0, (size - resized.shape[1]) // 2)
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return labelled(canvas, text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--review", required=True,
                        help="manual_review.json whose order should be audited")
    parser.add_argument("--output", required=True)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--page-size", type=int, default=5)
    parser.add_argument("--tile", type=int, default=360)
    args = parser.parse_args()

    baseline_path = Path(args.baseline).resolve()
    candidate_path = Path(args.candidate).resolve()
    snapshot = Path(args.snapshot).resolve()
    review = json.loads(Path(args.review).read_text())
    output = Path(args.output).resolve()
    rows_dir = output / "cases"
    rows_dir.mkdir(parents=True, exist_ok=True)
    _, baseline_cases = read_report(baseline_path)
    _, candidate_cases = read_report(candidate_path)

    audited = []
    rows = []
    for position, review_case in enumerate(review["cases"][:args.limit], 1):
        case_id = review_case["id"]
        old_case = baseline_cases[case_id]
        new_case = candidate_cases[case_id]
        old = read_masks(baseline_path.parent, old_case)
        new = read_masks(candidate_path.parent, new_case)
        source = cv2.imread(str(snapshot / new_case["source_file"]),
                            cv2.IMREAD_COLOR)
        if source is None:
            raise ValueError(f"missing source for {case_id}")
        foreground = decontaminate(source,
                                   new["full"].astype(np.float32) / 255.0)
        bounds = crop_bounds(new["full"])
        ownership = ((old["front"] > 127) != (new["front"] > 127)) & \
                    (new["full"] > 127)
        difference = np.full_like(source, 31)
        difference[ownership] = (40, 190, 255)
        panels = [
            tile(crop(source, bounds), f"{position}. {case_id} - source", args.tile),
            tile(crop(dark_composite(foreground, new["full"]), bounds),
                 "candidate - full", args.tile),
            tile(crop(dark_composite(foreground, old["front"]), bounds),
                 "v6 - front", args.tile),
            tile(crop(dark_composite(foreground, new["front"]), bounds),
                 "candidate - front", args.tile),
            tile(crop(difference, bounds),
                 f"ownership delta ({int(ownership.sum())} px)", args.tile),
            tile(crop(dark_composite(foreground, old["back"]), bounds),
                 "v6 - back", args.tile),
            tile(crop(dark_composite(foreground, new["back"]), bounds),
                 "candidate - back", args.tile),
        ]
        row = np.concatenate(panels, axis=1)
        row_path = rows_dir / f"{position:02d}-{case_id}.png"
        cv2.imwrite(str(row_path), row)
        rows.append(row)
        audited.append({
            "position": position,
            "id": case_id,
            "ownership_changed_binary_px": int(ownership.sum()),
            "full_changed_binary_px": int(((old["full"] > 127) !=
                                            (new["full"] > 127)).sum()),
            "row": str(row_path.relative_to(output)),
        })

    pages = []
    for offset in range(0, len(rows), args.page_size):
        page_name = f"audit_{offset // args.page_size + 1:02d}.jpg"
        page = np.concatenate(rows[offset:offset + args.page_size], axis=0)
        cv2.imwrite(str(output / page_name), page,
                    [cv2.IMWRITE_JPEG_QUALITY, 97])
        pages.append(page_name)
    (output / "audit.json").write_text(json.dumps({
        "baseline": str(baseline_path),
        "candidate": str(candidate_path),
        "cases": audited,
        "pages": pages,
    }, indent=2) + "\n")
    print(output / "audit.json")
    for page in pages:
        print(output / page)


if __name__ == "__main__":
    main()
