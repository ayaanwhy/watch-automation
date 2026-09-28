#!/usr/bin/env python3
"""Materialize complete manual edits for a sparse final-layer refiner.

Every item contains the production full/back partition and its desired final
partition.  Reviewed cases use the audited full and back correction assets;
manually accepted cases remain exact identity examples.  Unlike the older
ownership-only materializer, no full-mask correction is discarded.
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


def write(path: Path, image: np.ndarray):
    if not cv2.imwrite(str(path), image):
        raise ValueError(f"could not write {path}")


def state(full: np.ndarray, back: np.ndarray) -> np.ndarray:
    full_solid = full > 127
    back_solid = (back > 127) & full_solid
    result = np.zeros(full.shape, np.uint8)
    result[full_solid] = 2
    result[back_solid] = 3
    return result


def main():
    args = parse_args()
    report_path = Path(args.report).resolve()
    correction_root = Path(args.corrections).resolve()
    snapshot = Path(args.snapshot).resolve()
    output = Path(args.out).resolve()
    if output.exists():
        raise ValueError(f"refusing to overwrite existing output: {output}")

    report = json.loads(report_path.read_text())
    correction_manifest_path = correction_root / "manifest.json"
    correction_manifest = json.loads(correction_manifest_path.read_text())
    snapshot_manifest_path = snapshot / "manifest.json"
    snapshot_manifest = json.loads(snapshot_manifest_path.read_text())
    snapshot_id = report["snapshot_id"]
    if not (snapshot_id == correction_manifest["snapshot_id"] ==
            snapshot_manifest["snapshot_id"]):
        raise ValueError("report, corrections, and snapshot do not match")

    corrected = {row["id"]: row for row in correction_manifest["cases"]}
    report_cases = [row for row in report["cases"] if row.get("masks")]
    report_ids = {row["id"] for row in report_cases}
    missing = sorted(set(corrected) - report_ids)
    if missing:
        raise ValueError(f"corrected cases missing from report: {missing}")

    output.mkdir(parents=True)
    records = []
    action_totals = {"to_background": 0, "to_front": 0, "to_back": 0}
    for case in sorted(report_cases, key=lambda row: row["id"]):
        case_id = case["id"]
        source_path = snapshot / case["source_file"]
        if sha256(source_path) != case["source_sha256"]:
            raise ValueError(f"source hash mismatch for {case_id}")
        source = read(source_path, cv2.IMREAD_COLOR)
        base_full = read(report_path.parent / case["masks"]["full"],
                         cv2.IMREAD_GRAYSCALE)
        base_back = read(report_path.parent / case["masks"]["back"],
                         cv2.IMREAD_GRAYSCALE)
        correction = corrected.get(case_id)
        if correction is None:
            target_full = base_full.copy()
            target_back = base_back.copy()
            target_source = "reviewed_identity"
            split = "train"
        else:
            if correction["source_sha256"] != case["source_sha256"]:
                raise ValueError(f"correction source hash mismatch for {case_id}")
            target_full = read(correction_root / case_id / "full.png",
                               cv2.IMREAD_GRAYSCALE)
            target_back = read(correction_root / case_id / "back.png",
                               cv2.IMREAD_GRAYSCALE)
            target_source = "reviewed_correction"
            split = correction["split"]

        shapes = {source.shape[:2], base_full.shape, base_back.shape,
                  target_full.shape, target_back.shape}
        if len(shapes) != 1:
            raise ValueError(f"shape mismatch for {case_id}: {shapes}")
        if np.any((target_back > 127) & ~(target_full > 127)):
            raise ValueError(f"target back escapes target full for {case_id}")

        base_state = state(base_full, base_back)
        target_state = state(target_full, target_back)
        action = target_state.copy()
        action[target_state == base_state] = 0
        counts = {
            "to_background": 0,
            "to_front": int((action == 2).sum()),
            "to_back": int((action == 3).sum()),
        }
        # Background is state zero, so changed-to-background needs an explicit
        # class value of one in the serialized target.
        to_background = (target_state == 0) & (target_state != base_state)
        action[to_background] = 1
        counts["to_background"] = int(to_background.sum())
        for key in action_totals:
            action_totals[key] += counts[key]

        union_full = np.maximum(base_full, target_full)
        y0, y1, x0, x1 = crop_bounds(union_full, args.margin)
        destination = output / case_id
        destination.mkdir()
        write(destination / "img.png", np.dstack((
            source[y0:y1, x0:x1], base_full[y0:y1, x0:x1])))
        write(destination / "base_back.png", base_back[y0:y1, x0:x1])
        write(destination / "full.png", target_full[y0:y1, x0:x1])
        write(destination / "back.png", target_back[y0:y1, x0:x1])
        write(destination / "action.png", action[y0:y1, x0:x1])
        group_id = design_group(case)
        metadata = {
            "has_back": True,
            "real_background": True,
            "design_id": group_id,
            "family": "layer_refiner",
            "source": "final_layer_residual_v1",
            "target_source": target_source,
            "benchmark_case": case_id,
            "source_sha256": case["source_sha256"],
            "split": split,
            "actions_native": counts,
        }
        (destination / "meta.json").write_text(
            json.dumps(metadata, indent=2) + "\n")
        records.append({
            "case_id": case_id,
            "design_id": group_id,
            "split": split,
            "target_source": target_source,
            "source_sha256": case["source_sha256"],
            "actions_native": counts,
            "crop": {"top": y0, "bottom": y1, "left": x0, "right": x1},
        })

    holdout_designs = sorted({row["design_id"] for row in records
                              if row["split"] == "holdout"})
    payload = {
        "schema": "jewelsense.final-layer-residual-dataset/v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "snapshot_id": snapshot_id,
        "snapshot_manifest_sha256": sha256(snapshot_manifest_path),
        "baseline_report": str(report_path),
        "baseline_runtime": report["runtime"]["signature"],
        "baseline_model_sha256": report["runtime"]["model_sha256"],
        "correction_manifest": str(correction_manifest_path),
        "correction_manifest_sha256": sha256(correction_manifest_path),
        "margin": args.margin,
        "counts": {
            "cases": len(records),
            "identity": sum(row["target_source"] == "reviewed_identity"
                            for row in records),
            "corrected": sum(row["target_source"] == "reviewed_correction"
                             for row in records),
            "corrected_holdout": sum(row["split"] == "holdout"
                                     for row in records),
            "actions_native": action_totals,
        },
        "holdout_designs": holdout_designs,
        "cases": records,
    }
    (output / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps(payload["counts"], indent=2))
    print(f"[ok] {output}")


if __name__ == "__main__":
    main()
