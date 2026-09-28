#!/usr/bin/env python3
"""Align native manual edit pixels with cached correction training crops."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_gray(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError(f"could not read mask: {path}")
    return image


def align_edit(edit: np.ndarray, corrected_full: np.ndarray,
               output_shape: tuple[int, int], margin: float) -> np.ndarray:
    ys, xs = np.nonzero(corrected_full > 127)
    if not len(xs):
        raise ValueError("corrected full mask is empty")
    height, width = corrected_full.shape
    pad = int(margin * max(np.ptp(ys) + 1, np.ptp(xs) + 1))
    y0, y1 = max(int(ys.min()) - pad, 0), min(int(ys.max()) + pad, height)
    x0, x1 = max(int(xs.min()) - pad, 0), min(int(xs.max()) + pad, width)
    cropped = edit[y0:y1, x0:x1].astype(np.uint8) * 255
    out_height, out_width = output_shape
    if cropped.shape != output_shape:
        cropped = cv2.resize(cropped, (out_width, out_height),
                             interpolation=cv2.INTER_NEAREST)
    return cropped


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--cache", required=True,
                        help="materialized corrected cache containing train/")
    parser.add_argument("--out", required=True)
    parser.add_argument("--margin", type=float, default=0.10)
    return parser.parse_args()


def main():
    args = parse_args()
    report_path = Path(args.report).resolve()
    assets = Path(args.assets).resolve()
    cache = Path(args.cache).resolve()
    output = Path(args.out).resolve()
    if output.exists():
        raise ValueError(f"refusing to overwrite existing output: {output}")

    report = json.loads(report_path.read_text())
    manifest = json.loads((assets / "manifest.json").read_text())
    if report["snapshot_id"] != manifest["snapshot_id"]:
        raise ValueError("report and assets refer to different snapshots")
    report_cases = {case["id"]: case for case in report["cases"]
                    if case.get("masks")}
    selected = [case for case in manifest["cases"] if case["split"] == "train"]
    output.mkdir(parents=True)
    records = []
    for correction in sorted(selected, key=lambda row: row["id"]):
        case_id = correction["id"]
        case = report_cases[case_id]
        baseline_full = read_gray(report_path.parent / case["masks"]["full"])
        baseline_back = read_gray(report_path.parent / case["masks"]["back"])
        corrected_full = read_gray(assets / case_id / "full.png")
        corrected_back = read_gray(assets / case_id / "back.png")
        native_matte_edit = (baseline_full > 127) != (corrected_full > 127)
        native_back_edit = (baseline_back > 127) != (corrected_back > 127)

        source_dir = cache / "train" / case_id
        cached_image = cv2.imread(str(source_dir / "img.png"),
                                  cv2.IMREAD_UNCHANGED)
        if cached_image is None:
            raise ValueError(f"missing corrected cache image for {case_id}")
        output_shape = cached_image.shape[:2]
        matte_edit = align_edit(native_matte_edit, corrected_full, output_shape,
                                args.margin)
        back_edit = align_edit(native_back_edit, corrected_full, output_shape,
                               args.margin)

        destination = output / case_id
        destination.mkdir()
        for name in ("img.png", "back.png"):
            (destination / name).symlink_to((source_dir / name).resolve())
        cv2.imwrite(str(destination / "matte_edit.png"), matte_edit)
        cv2.imwrite(str(destination / "back_edit.png"), back_edit)
        meta = json.loads((source_dir / "meta.json").read_text())
        meta.update({
            "design_id": f"ownership-pixel-v4:{case_id}",
            "family": "correction_pixel",
            "source": "benchmark_manual_pixel_edits_v4",
            "manual_full_edit_pixels_native": int(native_matte_edit.sum()),
            "manual_back_edit_pixels_native": int(native_back_edit.sum()),
            "manual_full_edit_pixels_cache": int((matte_edit > 127).sum()),
            "manual_back_edit_pixels_cache": int((back_edit > 127).sum()),
        })
        (destination / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
        records.append({
            "case_id": case_id,
            "source_sha256": correction["source_sha256"],
            "matte_edit_pixels_native": int(native_matte_edit.sum()),
            "back_edit_pixels_native": int(native_back_edit.sum()),
            "matte_edit_pixels_cache": int((matte_edit > 127).sum()),
            "back_edit_pixels_cache": int((back_edit > 127).sum()),
        })

    payload = {
        "schema": "jewelsense.pixel-edit-supervision/v1",
        "snapshot_id": report["snapshot_id"],
        "baseline_report": str(report_path),
        "baseline_runtime": report["runtime"]["signature"],
        "correction_manifest_sha256": sha256(assets / "manifest.json"),
        "cases": records,
    }
    (output / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(f"materialized {len(records)} pixel-edit cases")
    print("cache edit pixels: matte=", sum(row["matte_edit_pixels_cache"]
                                             for row in records),
          "back=", sum(row["back_edit_pixels_cache"] for row in records))


if __name__ == "__main__":
    main()
