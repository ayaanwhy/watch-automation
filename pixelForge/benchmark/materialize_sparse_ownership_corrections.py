#!/usr/bin/env python3
"""Materialize manual API edits as sparse targets over teacher raw outputs.

Manual correction masks describe the final, post-processed API layers. Using
those masks as dense raw-network targets applies deterministic cleanup twice.
This builder instead preserves the current model's raw targets everywhere and
overrides only pixels that a reviewer changed in the final API output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from deploy import serve
from vto.ingest import _write


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


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True,
                        help="benchmark report used as the correction baseline")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--assets", required=True,
                        help="materialized native corrected masks")
    parser.add_argument("--out", required=True)
    parser.add_argument("--size", type=int, default=512)
    return parser.parse_args()


def main():
    args = parse_args()
    report_path = Path(args.report).resolve()
    snapshot = Path(args.snapshot).resolve()
    assets = Path(args.assets).resolve()
    output = Path(args.out).resolve()
    if output.exists():
        raise ValueError(f"refusing to overwrite existing output: {output}")

    report = json.loads(report_path.read_text())
    manifest = json.loads((assets / "manifest.json").read_text())
    if report.get("snapshot_id") != manifest.get("snapshot_id"):
        raise ValueError("report and correction assets use different snapshots")
    model_path = Path(serve.MODEL).resolve()
    model_sha = sha256(model_path)
    if report["runtime"]["model_sha256"] != model_sha:
        raise ValueError("loaded teacher model differs from correction baseline")

    report_cases = {case["id"]: case for case in report["cases"]
                    if case.get("masks")}
    selected = [case for case in manifest["cases"] if case["split"] == "train"]
    records = []
    for index, correction in enumerate(sorted(selected, key=lambda row: row["id"]), 1):
        case_id = correction["id"]
        case = report_cases[case_id]
        if case["source_sha256"] != correction["source_sha256"]:
            raise ValueError(f"source hash differs for {case_id}")
        source_path = snapshot / case["source_file"]
        source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
        if source is None:
            raise ValueError(f"could not read source: {source_path}")

        baseline_full = read_gray(report_path.parent / case["masks"]["full"]) > 127
        baseline_back = read_gray(report_path.parent / case["masks"]["back"]) > 127
        corrected_full = read_gray(assets / case_id / "full.png") > 127
        corrected_back = read_gray(assets / case_id / "back.png") > 127
        if not (source.shape[:2] == baseline_full.shape == corrected_full.shape):
            raise ValueError(f"native dimensions differ for {case_id}")

        edit_full = baseline_full != corrected_full
        edit_back = baseline_back != corrected_back
        teacher_alpha, teacher_back = serve._predict_crop(source)
        target_alpha = np.clip(teacher_alpha, 0.0, 1.0)
        target_back = teacher_back > serve.BACK_THR
        target_alpha[edit_full] = corrected_full[edit_full].astype(np.float32)
        target_back[edit_back] = corrected_back[edit_back]
        target_back &= target_alpha > 0.5

        _write(str(output), case_id, source, target_alpha,
               target_back.astype(np.float32), args.size, 0.10,
               has_back=True, real=True,
               design_id=f"ownership-sparse-v4:{case_id}",
               family="correction_sparse",
               source="benchmark_sparse_ownership_v4")
        case_dir = output / case_id
        meta_path = case_dir / "meta.json"
        meta = json.loads(meta_path.read_text())
        meta.update({
            "benchmark_case": case_id,
            "baseline_runtime": report["runtime"]["signature"],
            "teacher_model_sha256": model_sha,
            "manual_full_edit_pixels_native": int(edit_full.sum()),
            "manual_back_edit_pixels_native": int(edit_back.sum()),
        })
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")
        records.append({
            "case_id": case_id,
            "source_sha256": case["source_sha256"],
            "manual_full_edit_pixels_native": int(edit_full.sum()),
            "manual_back_edit_pixels_native": int(edit_back.sum()),
            "img_sha256": sha256(case_dir / "img.png"),
            "back_sha256": sha256(case_dir / "back.png"),
            "meta_sha256": sha256(meta_path),
        })
        print(f"[{index:02d}/{len(selected)}] {case_id}: "
              f"full edits={int(edit_full.sum())} "
              f"back edits={int(edit_back.sum())}")

    sparse_manifest = {
        "schema": "jewelsense.sparse-ownership-training/v1",
        "snapshot_id": report["snapshot_id"],
        "baseline_report": str(report_path),
        "baseline_runtime": report["runtime"]["signature"],
        "teacher_model": str(model_path),
        "teacher_model_sha256": model_sha,
        "correction_manifest_sha256": sha256(assets / "manifest.json"),
        "cases": records,
    }
    (output / "manifest.json").write_text(
        json.dumps(sparse_manifest, indent=2) + "\n")
    print(f"materialized {len(records)} sparse training cases in {output}")


if __name__ == "__main__":
    main()
