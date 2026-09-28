#!/usr/bin/env python3
"""Build dense final-output targets for an aligned ownership student.

The production model predicts a coarse matte and rear-layer probability, then
``deploy.serve`` applies deterministic geometry cleanup.  Manual corrections
describe the *final* API masks, so mixing those masks with coarse targets
trains the wrong function.  This materializer gives every student example the
same target space:

* reviewed cases use the corrected final masks;
* all other available snapshot cases use the current production final masks;
* reviewed holdouts remain present for evaluation but are explicitly excluded
  from training by their ``design_id``.

Each cached item is cropped around the final matte with the same catalogue RGB
and carries a strict ``back subset-of full`` invariant.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True,
                        help="production benchmark report supplying teacher masks")
    parser.add_argument("--corrections", required=True,
                        help="audited correction asset directory")
    parser.add_argument("--snapshot", required=True,
                        help="snapshot directory containing source images")
    parser.add_argument("--out", required=True)
    parser.add_argument("--margin", type=float, default=0.10)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_image(path: Path, flags: int) -> np.ndarray:
    image = cv2.imread(str(path), flags)
    if image is None:
        raise ValueError(f"could not read image: {path}")
    return image


def crop_bounds(mask: np.ndarray, margin: float) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask > 127)
    if not len(xs):
        raise ValueError("final full mask is empty")
    height, width = mask.shape
    pad = int(round(float(margin) * max(np.ptp(ys) + 1, np.ptp(xs) + 1)))
    y0 = max(int(ys.min()) - pad, 0)
    y1 = min(int(ys.max()) + pad + 1, height)
    x0 = max(int(xs.min()) - pad, 0)
    x1 = min(int(xs.max()) + pad + 1, width)
    return y0, y1, x0, x1


def design_group(case: dict) -> str:
    """Group visually related configurations for leakage-safe validation.

    Core, extreme, natural, and curated risk cases sharing a centre shape and
    head reuse the same dominant geometry, even if the mounting or stone size
    changes.  Side-setting cases instead share their rail construction.  The
    grouping is intentionally broader than a case id so a holdout cannot be
    solved by memorizing an adjacent colour/length/mounting variant.
    """
    case_id = case["id"]
    selected = case["selected"]
    if case_id.startswith("side-"):
        return f"final-side:{selected.get('Side setting', 'none')}"
    if case_id.startswith("metal-"):
        return "final-metal"
    shape = selected.get("Center stone shape")
    head = selected.get("Ring head type")
    if shape and head:
        return f"final-geometry:{shape}:{head}"
    return f"final-case:{case_id}"


def write_case(destination: Path, source: np.ndarray, full: np.ndarray,
               back: np.ndarray, metadata: dict, margin: float) -> dict:
    if source.shape[:2] != full.shape or back.shape != full.shape:
        raise ValueError(
            f"shape mismatch for {metadata['benchmark_case']}: "
            f"source={source.shape[:2]} full={full.shape} back={back.shape}")
    full_solid = full > 127
    back_solid = back > 127
    outside = int((back_solid & ~full_solid).sum())
    if outside:
        raise ValueError(
            f"back target escapes full matte for {metadata['benchmark_case']}: "
            f"{outside} pixels")

    y0, y1, x0, x1 = crop_bounds(full, margin)
    crop_source = source[y0:y1, x0:x1]
    crop_full = full[y0:y1, x0:x1]
    crop_back = back[y0:y1, x0:x1]
    rgba = np.dstack((crop_source, crop_full))
    destination.mkdir()
    if not cv2.imwrite(str(destination / "img.png"), rgba):
        raise ValueError(f"failed to write {destination / 'img.png'}")
    if not cv2.imwrite(str(destination / "back.png"), crop_back):
        raise ValueError(f"failed to write {destination / 'back.png'}")
    (destination / "meta.json").write_text(
        json.dumps(metadata, indent=2) + "\n")
    return {
        "crop": {"top": y0, "bottom": y1, "left": x0, "right": x1},
        "full_pixels": int(full_solid.sum()),
        "back_pixels": int(back_solid.sum()),
        "img_sha256": sha256(destination / "img.png"),
        "back_sha256": sha256(destination / "back.png"),
    }


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
    if report["snapshot_id"] != correction_manifest["snapshot_id"]:
        raise ValueError("report and corrections refer to different snapshots")
    if report["snapshot_id"] != snapshot_manifest["snapshot_id"]:
        raise ValueError("report and snapshot refer to different snapshots")

    corrected = {row["id"]: row for row in correction_manifest["cases"]}
    report_cases = [row for row in report["cases"] if row.get("masks")]
    report_ids = {row["id"] for row in report_cases}
    missing = sorted(set(corrected) - report_ids)
    if missing:
        raise ValueError(f"corrected cases missing from teacher report: {missing}")

    output.mkdir(parents=True)
    records = []
    for case in sorted(report_cases, key=lambda row: row["id"]):
        case_id = case["id"]
        source_path = snapshot / case["source_file"]
        if sha256(source_path) != case["source_sha256"]:
            raise ValueError(f"source hash mismatch for {case_id}")
        source = read_image(source_path, cv2.IMREAD_COLOR)

        correction = corrected.get(case_id)
        if correction is not None:
            if correction["source_sha256"] != case["source_sha256"]:
                raise ValueError(f"correction source hash mismatch for {case_id}")
            full_path = corrections / case_id / "full.png"
            back_path = corrections / case_id / "back.png"
            split = correction["split"]
            target_source = "reviewed_correction"
            family = "final"
        else:
            full_path = report_path.parent / case["masks"]["full"]
            back_path = report_path.parent / case["masks"]["back"]
            split = "train"
            target_source = "production_teacher"
            family = "final"
        full = read_image(full_path, cv2.IMREAD_GRAYSCALE)
        back = read_image(back_path, cv2.IMREAD_GRAYSCALE)
        group_id = design_group(case)
        metadata = {
            "has_back": True,
            "real_background": True,
            "design_id": group_id,
            "family": family,
            "source": "final_output_student_v1",
            "target_source": target_source,
            "target_space": "final_api_layers",
            "benchmark_case": case_id,
            "source_sha256": case["source_sha256"],
            "split": split,
        }
        stats = write_case(output / case_id, source, full, back, metadata,
                           args.margin)
        records.append({
            "case_id": case_id,
            "design_id": group_id,
            "split": split,
            "target_source": target_source,
            "source_sha256": case["source_sha256"],
            **stats,
        })

    holdout_designs = sorted(set(row["design_id"] for row in records
                                 if row["split"] == "holdout"))
    payload = {
        "schema": "jewelsense.final-output-student-dataset/v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "snapshot_id": report["snapshot_id"],
        "snapshot_manifest_sha256": sha256(snapshot_manifest_path),
        "teacher_report": str(report_path),
        "teacher_runtime": report["runtime"]["signature"],
        "teacher_model_sha256": report["runtime"]["model_sha256"],
        "correction_manifest": str(correction_manifest_path),
        "correction_manifest_sha256": sha256(correction_manifest_path),
        "target_space": "final_api_layers",
        "margin": args.margin,
        "counts": {
            "cases": len(records),
            "teacher": sum(row["target_source"] == "production_teacher"
                           for row in records),
            "corrected_train": sum(
                row["target_source"] == "reviewed_correction" and
                row["split"] == "train" for row in records),
            "corrected_holdout": sum(row["split"] == "holdout"
                                     for row in records),
        },
        "holdout_designs": holdout_designs,
        "cases": records,
    }
    (output / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps(payload["counts"], indent=2))
    print(f"[ok] {output}")


if __name__ == "__main__":
    main()
