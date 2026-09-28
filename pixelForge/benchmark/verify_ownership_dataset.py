#!/usr/bin/env python3
"""Verify a materialized ownership dataset against its audit manifest."""

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


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--train", type=int, default=56)
    parser.add_argument("--holdout", type=int, default=16)
    return parser.parse_args()


def main():
    args = parse_args()
    assets = Path(args.assets).resolve()
    cache = Path(args.cache).resolve()
    manifest_path = assets / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    cases = manifest["cases"]
    expected_ids = {case["id"] for case in cases}
    expected_split = {case["id"]: case["split"] for case in cases}

    train_ids = {path.name for path in (cache / "train").iterdir() if path.is_dir()}
    holdout_ids = {path.name for path in (cache / "holdout").iterdir() if path.is_dir()}
    if train_ids & holdout_ids:
        raise ValueError("train and holdout contain overlapping case IDs")
    if len(train_ids) != args.train or len(holdout_ids) != args.holdout:
        raise ValueError(
            f"split count mismatch: train={len(train_ids)} holdout={len(holdout_ids)}"
        )
    if train_ids | holdout_ids != expected_ids:
        raise ValueError("cache case IDs differ from the manifest")

    for case in cases:
        case_id = case["id"]
        native_dir = assets / case_id
        cache_dir = cache / expected_split[case_id] / case_id
        for area, directory in (("native", native_dir), ("cache", cache_dir)):
            expected_hashes = case["artifact_sha256"][area]
            actual_names = {path.name for path in directory.iterdir() if path.is_file()}
            if actual_names != set(expected_hashes):
                raise ValueError(f"{case_id} {area} file set differs from manifest")
            for name, expected in expected_hashes.items():
                actual = sha256(directory / name)
                if actual != expected:
                    raise ValueError(f"{case_id} {area}/{name} hash mismatch")

        full = cv2.imread(str(native_dir / "full.png"), cv2.IMREAD_GRAYSCALE)
        front = cv2.imread(str(native_dir / "front.png"), cv2.IMREAD_GRAYSCALE)
        back = cv2.imread(str(native_dir / "back.png"), cv2.IMREAD_GRAYSCALE)
        if full is None or front is None or back is None:
            raise ValueError(f"{case_id} has unreadable native masks")
        if not np.array_equal(np.maximum(front, back), full):
            raise ValueError(f"{case_id} front/back do not exactly partition full")
        if np.any((front > 0) & (back > 0)):
            raise ValueError(f"{case_id} front/back alpha overlap")

    source_export = Path(manifest["source_export"])
    if sha256(source_export) != manifest["source_export_sha256"]:
        raise ValueError("final correction export hash mismatch")

    print(f"verified {len(cases)} labels: train={len(train_ids)} "
          f"holdout={len(holdout_ids)}")
    print(f"added matte pixels={sum(case['added_full_pixels'] for case in cases)}")
    print(f"removed matte pixels={sum(case['removed_full_pixels'] for case in cases)}")
    print(f"manifest sha256={sha256(manifest_path)}")


if __name__ == "__main__":
    main()
