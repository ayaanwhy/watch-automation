#!/usr/bin/env python3
"""Build an offline, change-only visual review for two benchmark runs."""

import argparse
import html
import json
from pathlib import Path

import cv2
import numpy as np

from build_manual_review import (dark_composite, decontaminate, fit_tile,
                                 labelled)


def changed_regions(mask):
    """Return connected changed-pixel regions as JSON-safe rectangles."""
    count, _, stats, centroids = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), 8)
    regions = []
    for index in range(1, count):
        x, y, width, height, area = stats[index].tolist()
        regions.append({
            "x": x, "y": y, "width": width, "height": height,
            "pixels": area,
            "center": [round(float(value), 2) for value in centroids[index]],
        })
    return regions


def mark_regions(image, regions, colour):
    """Circle tiny changed regions so they remain obvious on a contact sheet."""
    marked = image.copy()
    for region in regions:
        x, y = region["x"], region["y"]
        width, height = region["width"], region["height"]
        padding = max(16, 28 - max(width, height))
        cv2.rectangle(
            marked,
            (max(0, x - padding), max(0, y - padding)),
            (min(marked.shape[1] - 1, x + width + padding),
             min(marked.shape[0] - 1, y + height + padding)),
            colour, 3, cv2.LINE_AA,
        )
    return marked


def case_map(report):
    return {case["id"]: case for case in report["cases"] if case.get("masks")}


def read_mask(result_dir, case, layer):
    mask = cv2.imread(str(result_dir / case["masks"][layer]),
                      cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise ValueError(f"could not read {case['id']} {layer} mask")
    return mask


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True, help="baseline report.json")
    parser.add_argument("--candidate", required=True, help="candidate report.json")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--page-size", type=int, default=12)
    parser.add_argument("--case", action="append", default=[],
                        help="limit output to this case ID; may be repeated")
    args = parser.parse_args()

    baseline_path = Path(args.baseline).resolve()
    candidate_path = Path(args.candidate).resolve()
    snapshot_dir = Path(args.snapshot).resolve()
    output_dir = candidate_path.parent
    rows_dir = output_dir / "layer_comparison_rows"
    rows_dir.mkdir(exist_ok=True)

    baseline = json.loads(baseline_path.read_text())
    candidate = json.loads(candidate_path.read_text())
    if baseline["snapshot_id"] != candidate["snapshot_id"]:
        raise ValueError("reports use different source snapshots")
    baseline_cases = case_map(baseline)
    candidate_cases = case_map(candidate)
    if baseline_cases.keys() != candidate_cases.keys():
        raise ValueError("reports do not contain the same successful cases")

    reviewed = []
    sheet_rows = []
    selected_cases = set(args.case)
    for case_id in sorted(candidate_cases):
        if selected_cases and case_id not in selected_cases:
            continue
        old_case = baseline_cases[case_id]
        new_case = candidate_cases[case_id]
        old_masks = {layer: read_mask(baseline_path.parent, old_case, layer)
                     for layer in ("full", "front", "back")}
        new_masks = {layer: read_mask(candidate_path.parent, new_case, layer)
                     for layer in ("full", "front", "back")}
        changes = {layer: old_masks[layer] != new_masks[layer]
                   for layer in old_masks}
        changed_counts = {layer: int(mask.sum())
                          for layer, mask in changes.items()}
        binary_changes = {
            layer: (old_masks[layer] > 127) != (new_masks[layer] > 127)
            for layer in old_masks
        }
        # Sub-threshold alpha differences can be caused by harmless floating
        # point variation between ONNX exports. Keep this review focused on
        # visible silhouette or ownership decisions.
        if not any(int(mask.sum()) for mask in binary_changes.values()):
            continue

        source = cv2.imread(str(snapshot_dir / new_case["source_file"]),
                            cv2.IMREAD_COLOR)
        if source is None:
            raise ValueError(f"could not read source for {case_id}")
        foreground = decontaminate(
            source, new_masks["full"].astype(np.float32) / 255.0)
        # Mark actual silhouette/layer ownership changes.  Pure alpha-feather
        # differences still appear in the panels, but do not create a giant
        # bounding box around the entire antialiased contour.
        changed = (binary_changes["front"] | binary_changes["back"] |
                   binary_changes["full"])
        regions = changed_regions(changed)
        red = (65, 65, 255)
        green = (75, 225, 90)
        difference = np.full_like(source, 31)
        old_full = old_masks["full"] > 127
        new_full = new_masks["full"] > 127
        difference[old_full & ~new_full] = red
        difference[new_full & ~old_full] = green
        ownership_change = ((binary_changes["front"] | binary_changes["back"]) &
                            old_full & new_full)
        difference[ownership_change] = (40, 190, 255)
        panels = [
            labelled(fit_tile(source), f"{case_id} source"),
            labelled(fit_tile(dark_composite(foreground, old_masks["full"])),
                f"baseline full / {changed_counts['full']} alpha px"),
            labelled(fit_tile(dark_composite(foreground, new_masks["full"])),
                f"candidate full / {int(binary_changes['full'].sum())} binary px"),
            labelled(fit_tile(difference),
                     "diff: red removed / green added / amber layer"),
            labelled(fit_tile(dark_composite(foreground, old_masks["front"])),
                     f"baseline front / {changed_counts['front']} alpha px"),
            labelled(fit_tile(dark_composite(foreground, new_masks["front"])),
                     f"candidate front / {int(binary_changes['front'].sum())} binary px"),
            labelled(fit_tile(dark_composite(foreground, new_masks["back"])),
                     f"candidate back / {int(binary_changes['back'].sum())} binary px"),
        ]
        row = np.concatenate(panels, axis=1)
        row_path = rows_dir / f"{case_id}.webp"
        cv2.imwrite(str(row_path), row, [cv2.IMWRITE_WEBP_QUALITY, 96])
        sheet_rows.append(row)
        reviewed.append({
            "id": case_id,
            "row": str(row_path.relative_to(output_dir)),
            "changed_pixels": changed_counts,
            "binary_changed_pixels": {
                layer: int(mask.sum()) for layer, mask in binary_changes.items()
            },
            "regions": regions,
        })

    pages = []
    for offset in range(0, len(sheet_rows), args.page_size):
        page = np.concatenate(sheet_rows[offset:offset + args.page_size], axis=0)
        name = f"layer_comparison_{offset // args.page_size + 1:03d}.jpg"
        cv2.imwrite(str(output_dir / name), page,
                    [cv2.IMWRITE_JPEG_QUALITY, 95])
        pages.append(name)

    payload = {
        "schema_version": 1,
        "snapshot_id": candidate["snapshot_id"],
        "baseline_runtime": baseline["runtime"]["signature"],
        "candidate_runtime": candidate["runtime"]["signature"],
        "changed_cases": len(reviewed),
        "total_changed_pixels": {
            layer: sum(case["changed_pixels"][layer] for case in reviewed)
            for layer in ("full", "front", "back")
        },
        "pages": pages,
        "cases": reviewed,
    }
    (output_dir / "layer_comparison_review.json").write_text(
        json.dumps(payload, indent=2) + "\n")

    cards = "\n".join(
        f'<article><h2>{html.escape(case["id"])}</h2>'
        f'<p>Changed pixels — full: {case["changed_pixels"]["full"]}, '
        f'front: {case["changed_pixels"]["front"]}, '
        f'back: {case["changed_pixels"]["back"]}</p>'
        f'<img src="{html.escape(case["row"])}" alt="{html.escape(case["id"])}">'
        f'</article>' for case in reviewed)
    document = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JewelSense layer comparison</title>
<style>body{{margin:0;background:#111;color:#eee;font:14px system-ui,sans-serif}}
header,article{{padding:12px 18px}}header{{position:sticky;top:0;background:#181818;
border-bottom:1px solid #444;z-index:2}}article{{border-bottom:1px solid #333}}
h1,h2,p{{margin:4px 0 10px}}img{{display:block;width:100%;height:auto;background:#1f1f1f}}
</style></head><body><header><h1>Changed layers only</h1>
<p>{len(reviewed)} cases. The diff panel uses red for removed silhouette, green for
added silhouette and amber for front/back ownership changes. Each row also includes
source, baseline/candidate full and front, and candidate back.</p></header>{cards}</body></html>'''
    (output_dir / "layer_comparison_review.html").write_text(document)
    print(output_dir / "layer_comparison_review.html")
    for page in pages:
        print(output_dir / page)


if __name__ == "__main__":
    main()
