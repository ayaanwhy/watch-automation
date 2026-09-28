#!/usr/bin/env python3
"""Materialize final-mask residual supervision for an ownership refiner.

Unlike a replacement segmenter, the refiner receives the current production
full/back masks as inputs and learns only the correction from that known-good
baseline.  Unreviewed examples are exact identity targets; reviewed examples
replace only the desired back ownership.  This makes identity preservation a
learned, measurable invariant rather than an image-hash exception.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from benchmark.materialize_final_student_dataset import crop_bounds, design_group


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--corrections", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--margin", type=float, default=0.10)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read(path: Path, flags: int) -> np.ndarray:
    image = cv2.imread(str(path), flags)
    if image is None:
        raise ValueError(f"could not read {path}")
    return image


def write_png(path: Path, image: np.ndarray):
    if not cv2.imwrite(str(path), image):
        raise ValueError(f"could not write {path}")


def main():
    args = parse_args()
    report_path = Path(args.report).resolve()
    corrections = Path(args.corrections).resolve()
    snapshot = Path(args.snapshot).resolve()
    output = Path(args.out).resolve()
    if output.exists():
        raise ValueError(f"refusing to overwrite existing output: {output}")

    report = json.loads(report_path.read_text())
    correction_manifest_path = corrections / "manifest.json"
    correction_manifest = json.loads(correction_manifest_path.read_text())
    snapshot_manifest_path = snapshot / "manifest.json"
    snapshot_manifest = json.loads(snapshot_manifest_path.read_text())
    if not (report["snapshot_id"] == correction_manifest["snapshot_id"] ==
            snapshot_manifest["snapshot_id"]):
        raise ValueError("report, corrections, and snapshot do not match")

    corrected = {row["id"]: row for row in correction_manifest["cases"]}
    report_cases = [row for row in report["cases"] if row.get("masks")]
    output.mkdir(parents=True)
    records = []
    clipped_target_pixels = 0
    for case in sorted(report_cases, key=lambda row: row["id"]):
        case_id = case["id"]
        source_path = snapshot / case["source_file"]
        if sha256(source_path) != case["source_sha256"]:
            raise ValueError(f"source hash mismatch for {case_id}")
        source = read(source_path, cv2.IMREAD_COLOR)
        baseline_full = read(
            report_path.parent / case["masks"]["full"], cv2.IMREAD_GRAYSCALE)
        baseline_back = read(
            report_path.parent / case["masks"]["back"], cv2.IMREAD_GRAYSCALE)
        correction = corrected.get(case_id)
        if correction is None:
            target_back = baseline_back.copy()
            target_source = "production_identity"
            split = "train"
        else:
            if correction["source_sha256"] != case["source_sha256"]:
                raise ValueError(f"correction source hash mismatch for {case_id}")
            target_back = read(corrections / case_id / "back.png",
                               cv2.IMREAD_GRAYSCALE)
            target_source = "reviewed_correction"
            split = correction["split"]

        if not (source.shape[:2] == baseline_full.shape ==
                baseline_back.shape == target_back.shape):
            raise ValueError(f"shape mismatch for {case_id}")
        outside = (target_back > 127) & ~(baseline_full > 127)
        clipped_target_pixels += int(outside.sum())
        target_back[outside] = 0
        edit = ((target_back > 127) != (baseline_back > 127)).astype(np.uint8) * 255
        y0, y1, x0, x1 = crop_bounds(baseline_full, args.margin)
        destination = output / case_id
        destination.mkdir()
        write_png(destination / "img.png", np.dstack((
            source[y0:y1, x0:x1], baseline_full[y0:y1, x0:x1])))
        write_png(destination / "base_back.png",
                  baseline_back[y0:y1, x0:x1])
        write_png(destination / "back.png", target_back[y0:y1, x0:x1])
        write_png(destination / "back_edit.png", edit[y0:y1, x0:x1])
        group_id = design_group(case)
        metadata = {
            "has_back": True,
            "real_background": True,
            "design_id": group_id,
            "family": "ownership_refiner",
            "source": "final_ownership_residual_v1",
            "target_source": target_source,
            "benchmark_case": case_id,
            "source_sha256": case["source_sha256"],
            "split": split,
            "edit_pixels_native": int((edit > 127).sum()),
        }
        (destination / "meta.json").write_text(
            json.dumps(metadata, indent=2) + "\n")
        records.append({
            "case_id": case_id,
            "design_id": group_id,
            "split": split,
            "target_source": target_source,
            "source_sha256": case["source_sha256"],
            "edit_pixels_native": metadata["edit_pixels_native"],
            "crop": {"top": y0, "bottom": y1, "left": x0, "right": x1},
        })

    holdout_designs = sorted(set(row["design_id"] for row in records
                                 if row["split"] == "holdout"))
    payload = {
        "schema": "jewelsense.final-ownership-residual-dataset/v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "snapshot_id": report["snapshot_id"],
        "snapshot_manifest_sha256": sha256(snapshot_manifest_path),
        "baseline_report": str(report_path),
        "baseline_runtime": report["runtime"]["signature"],
        "baseline_model_sha256": report["runtime"]["model_sha256"],
        "correction_manifest": str(correction_manifest_path),
        "correction_manifest_sha256": sha256(correction_manifest_path),
        "margin": args.margin,
        "counts": {
            "cases": len(records),
            "identity": sum(row["target_source"] == "production_identity"
                            for row in records),
            "corrected": sum(row["target_source"] == "reviewed_correction"
                             for row in records),
            "corrected_holdout": sum(row["split"] == "holdout"
                                     for row in records),
            "clipped_target_pixels_outside_baseline_full": clipped_target_pixels,
        },
        "holdout_designs": holdout_designs,
        "cases": records,
    }
    (output / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps(payload["counts"], indent=2))
    print(f"[ok] {output}")


if __name__ == "__main__":
    main()
