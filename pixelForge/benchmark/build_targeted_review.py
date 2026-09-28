"""Build dark-background review assets from targeted ``vto.predict`` output.

The predictor writes the original RGB into every RGBA layer, so ordinary image
viewers that ignore alpha can misleadingly make all three layers look equal.
This utility composites the alpha explicitly and preserves native-resolution
panels for edge inspection.
"""

import argparse
from pathlib import Path

import cv2
import numpy as np

from benchmark.build_manual_review import fit_tile, labelled


def dark_composite(rgba, background=31):
    alpha = rgba[..., 3:4].astype(np.float32) / 255.0
    return np.clip(rgba[..., :3] * alpha + background * (1.0 - alpha),
                   0, 255).astype(np.uint8)


def read_layers(case_dir):
    layer_dir = case_dir / "source" if (case_dir / "source").is_dir() else case_dir
    layers = {}
    for layer in ("full", "front", "back"):
        rgba = cv2.imread(str(layer_dir / f"{layer}.png"), cv2.IMREAD_UNCHANGED)
        if rgba is None or rgba.ndim != 3 or rgba.shape[2] != 4:
            raise ValueError(f"missing RGBA layer: {case_dir.name}/{layer}")
        layers[layer] = rgba
    return layers


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True,
                        help="directory containing <case>/source/{full,front,back}.png")
    parser.add_argument("--baseline", default=None,
                        help="optional second prediction root for change-focused panels")
    parser.add_argument("--tile", type=int, default=480)
    args = parser.parse_args()

    root = Path(args.root).resolve()
    rows = []
    cases = []
    for case_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        layers = read_layers(case_dir)
        panels = []
        for layer in ("full", "front", "back"):
            rgba = layers[layer]
            composite = dark_composite(rgba)
            cv2.imwrite(str(case_dir / f"{layer}_dark.png"), composite)
            panels.append(labelled(fit_tile(composite, args.tile),
                                   f"{case_dir.name} - {layer}"))
        row = np.concatenate(panels, axis=1)
        cv2.imwrite(str(case_dir / "review.jpg"), row,
                    [cv2.IMWRITE_JPEG_QUALITY, 97])
        rows.append(row)
        cases.append(case_dir.name)

    if not rows:
        raise SystemExit(f"no targeted predictions under {root}")
    sheet = np.concatenate(rows, axis=0)
    sheet_path = root / "targeted-review.jpg"
    cv2.imwrite(str(sheet_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 97])
    print(sheet_path)
    print(f"{len(cases)} cases: {', '.join(cases)}")

    if args.baseline:
        baseline = Path(args.baseline).resolve()
        comparison_rows = []
        for case_name in cases:
            new = read_layers(root / case_name)
            old = read_layers(baseline / case_name)
            old_masks = {key: value[..., 3] for key, value in old.items()}
            new_masks = {key: value[..., 3] for key, value in new.items()}
            old_full = old_masks["full"] > 127
            new_full = new_masks["full"] > 127
            old_front = old_masks["front"] > 127
            new_front = new_masks["front"] > 127
            difference = np.full(new["full"].shape[:2] + (3,), 31, np.uint8)
            difference[old_full & ~new_full] = (65, 65, 255)
            difference[new_full & ~old_full] = (75, 225, 90)
            ownership = old_front != new_front
            difference[ownership & old_full & new_full] = (40, 190, 255)
            full_changed = int((old_full != new_full).sum())
            ownership_changed = int((ownership & old_full & new_full).sum())
            panels = [
                labelled(fit_tile(dark_composite(old["full"]), args.tile),
                         f"{case_name} baseline full"),
                labelled(fit_tile(dark_composite(new["full"]), args.tile),
                         f"candidate full ({full_changed} binary px)"),
                labelled(fit_tile(difference, args.tile),
                         f"diff red/green matte; amber layer ({ownership_changed})"),
                labelled(fit_tile(dark_composite(old["front"]), args.tile),
                         "baseline front"),
                labelled(fit_tile(dark_composite(new["front"]), args.tile),
                         "candidate front"),
                labelled(fit_tile(dark_composite(new["back"]), args.tile),
                         "candidate back"),
            ]
            comparison_rows.append(np.concatenate(panels, axis=1))
        comparison = np.concatenate(comparison_rows, axis=0)
        comparison_path = root / "targeted-comparison.jpg"
        cv2.imwrite(str(comparison_path), comparison,
                    [cv2.IMWRITE_JPEG_QUALITY, 97])
        print(comparison_path)


if __name__ == "__main__":
    main()
