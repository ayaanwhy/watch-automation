#!/usr/bin/env python3
"""Validate exported ownership labels and materialize guarded training data.

The output keeps ``train`` and ``holdout`` in separate roots so the holdout
cannot accidentally enter ``--extra-data`` during fine-tuning.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from benchmark.correction_workflow import SCHEMA, decode_binary_mask
from vto.ingest import _write


READY_STATUSES = {"approved", "corrected"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_payload(payload: dict, report: dict, report_path: Path,
                     selection_path: Path) -> None:
    expected = {
        "schema": SCHEMA,
        "snapshot_id": report["snapshot_id"],
        "runtime_signature": report["runtime"]["signature"],
        "source_report_sha256": sha256(report_path),
        "selection_sha256": sha256(selection_path),
    }
    for key, value in expected.items():
        if payload.get(key) != value:
            raise ValueError(
                f"payload {key} mismatch: expected {value!r}, got {payload.get(key)!r}"
            )


def apply_exported_masks(full_u8: np.ndarray, state: dict):
    """Apply a reviewed full/back payload while preserving source edge alpha.

    ``full_runs`` is optional for backward compatibility. New matte pixels are
    materialized as opaque training targets; retained source pixels preserve
    their exact original alpha. Returned front/back alpha masks form an exact
    partition of the corrected full mask.
    """
    if full_u8.ndim != 2:
        raise ValueError("full matte must be a single-channel image")
    original_support = full_u8 > 0
    if "full_runs" in state:
        support = decode_binary_mask(state["full_runs"], full_u8.shape)
    else:
        # Schema-v2 exports created before matte removal was added mean
        # "keep the original full matte".
        support = original_support.copy()

    back = decode_binary_mask(state.get("back_runs", []), full_u8.shape)
    outside = int((back & ~support).sum())
    if outside:
        raise ValueError(f"correction has {outside} back pixels outside the corrected full matte")

    added = support & ~original_support
    corrected_full_u8 = np.where(added, 255, np.where(support, full_u8, 0)).astype(np.uint8)
    back_u8 = np.where(back, corrected_full_u8, 0).astype(np.uint8)
    front_u8 = np.where(back, 0, corrected_full_u8).astype(np.uint8)
    return support, back, corrected_full_u8, front_u8, back_u8


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corrections", required=True,
                        help="JSON exported by ownership_correction_review.html")
    parser.add_argument("--report", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--selection", required=True)
    parser.add_argument("--out", default="data/corrections/ownership-v3")
    parser.add_argument("--assets", default="benchmark/corrections/ownership-v3-assets")
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    corrections_path = Path(args.corrections).resolve()
    report_path = Path(args.report).resolve()
    snapshot_path = Path(args.snapshot).resolve()
    selection_path = Path(args.selection).resolve()
    output_path = Path(args.out).resolve()
    assets_path = Path(args.assets).resolve()

    payload = json.loads(corrections_path.read_text())
    report = json.loads(report_path.read_text())
    selection = json.loads(selection_path.read_text())
    validate_payload(payload, report, report_path, selection_path)
    report_by_id = {case["id"]: case for case in report["cases"]}
    selection_by_id = {case["id"]: case for case in selection["cases"]}
    unknown = set(payload.get("cases", {})) - set(selection_by_id)
    if unknown:
        raise ValueError(f"payload contains cases outside the frozen selection: {sorted(unknown)}")

    ready = {case_id: state for case_id, state in payload.get("cases", {}).items()
             if state.get("status") in READY_STATUSES}
    if not ready:
        raise ValueError("payload contains no approved or corrected labels")

    manifest = {
        "schema_version": 1,
        "correction_schema": SCHEMA,
        "snapshot_id": report["snapshot_id"],
        "runtime_signature": report["runtime"]["signature"],
        "source_export": str(corrections_path),
        "source_export_sha256": sha256(corrections_path),
        "selection_sha256": sha256(selection_path),
        "cases": [],
    }
    result_path = report_path.parent
    for case_id in sorted(ready):
        state = ready[case_id]
        case = report_by_id.get(case_id)
        selected_case = selection_by_id[case_id]
        if not case or case.get("status") != "ok" or not case.get("masks"):
            raise ValueError(f"case is not available in the source report: {case_id}")
        if state.get("source_sha256") != case.get("source_sha256"):
            raise ValueError(f"source hash mismatch for {case_id}")
        if state.get("split") != selected_case.get("split"):
            raise ValueError(f"train/holdout split mismatch for {case_id}")

        source_path = snapshot_path / case["source_file"]
        full_path = result_path / case["masks"]["full"]
        source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
        full_u8 = cv2.imread(str(full_path), cv2.IMREAD_GRAYSCALE)
        if source is None or full_u8 is None:
            raise ValueError(f"missing source or full mask for {case_id}")
        height, width = full_u8.shape
        if source.shape[:2] != (height, width):
            raise ValueError(f"source/mask dimensions differ for {case_id}")
        if (int(state.get("height", -1)), int(state.get("width", -1))) != (height, width):
            raise ValueError(f"exported dimensions differ for {case_id}")

        original_support = full_u8 > 0
        try:
            support, back, corrected_full_u8, front_u8, back_u8 = \
                apply_exported_masks(full_u8, state)
        except ValueError as error:
            raise ValueError(f"{case_id}: {error}") from error
        split = selected_case["split"]

        native_dir = assets_path / case_id
        cache_dir = output_path / split / case_id
        if not args.overwrite and (native_dir.exists() or cache_dir.exists()):
            raise FileExistsError(
                f"output already exists for {case_id}; use --overwrite only after reviewing the target"
            )
        native_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, native_dir / "source.jpg")
        cv2.imwrite(str(native_dir / "full.png"), corrected_full_u8)
        cv2.imwrite(str(native_dir / "front.png"), front_u8)
        cv2.imwrite(str(native_dir / "back.png"), back_u8)

        cache_root = output_path / split
        cache_root.mkdir(parents=True, exist_ok=True)
        full = corrected_full_u8.astype(np.float32) / 255.0
        _write(str(cache_root), case_id, source, full, back.astype(np.float32),
               args.size, 0.10, has_back=True, real=True,
               design_id=f"ownership-v3:{case_id}", family="correction",
               source="benchmark_manual_ownership_v3")
        meta_path = cache_dir / "meta.json"
        meta = json.loads(meta_path.read_text())
        meta.update({
            "benchmark_case": case_id,
            "correction_schema": SCHEMA,
            "correction_status": state["status"],
            "correction_notes": state.get("notes", ""),
            "split": split,
        })
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")

        native_hashes = {
            name: sha256(native_dir / name)
            for name in ("source.jpg", "full.png", "front.png", "back.png")
        }
        cache_hashes = {
            path.name: sha256(path)
            for path in sorted(cache_dir.iterdir()) if path.is_file()
        }

        count, _, stats, _ = cv2.connectedComponentsWithStats(back.astype(np.uint8), 8)
        component_areas = sorted((int(value) for value in stats[1:, cv2.CC_STAT_AREA]),
                                 reverse=True)
        manifest["cases"].append({
            "id": case_id,
            "split": split,
            "status": state["status"],
            "source_sha256": case["source_sha256"],
            "full_pixels": int(support.sum()),
            "added_full_pixels": int((support & ~original_support).sum()),
            "removed_full_pixels": int((original_support & ~support).sum()),
            "front_pixels": int((support & ~back).sum()),
            "back_pixels": int(back.sum()),
            "back_components": count - 1,
            "back_component_areas": component_areas,
            "partition_overlap_pixels": 0,
            "partition_missing_pixels": 0,
            "artifact_sha256": {
                "native": native_hashes,
                "cache": cache_hashes,
            },
        })
        print(f"[+] {case_id}: {split}, {int(back.sum())} back pixels")

    assets_path.mkdir(parents=True, exist_ok=True)
    (assets_path / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    counts = {split: sum(case["split"] == split for case in manifest["cases"])
              for split in ("train", "holdout")}
    print(f"[✓] materialized {len(manifest['cases'])} labels: "
          f"train={counts['train']} holdout={counts['holdout']}")
    print(f"[✓] cache: {output_path}")
    print(f"[✓] native regression masks: {assets_path}")


if __name__ == "__main__":
    main()
