#!/usr/bin/env python3
"""Evaluate native-resolution benchmark masks against reviewed corrections."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


LAYERS = ("full", "front", "back")


def read_mask(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise FileNotFoundError(path)
    if image.ndim == 3:
        image = image[:, :, 3] if image.shape[2] == 4 else image[:, :, 0]
    return image > 127


def layer_metrics(predicted: np.ndarray, expected: np.ndarray) -> dict:
    intersection = int(np.count_nonzero(predicted & expected))
    union = int(np.count_nonzero(predicted | expected))
    predicted_pixels = int(np.count_nonzero(predicted))
    expected_pixels = int(np.count_nonzero(expected))
    return {
        "iou": intersection / union if union else 1.0,
        "precision": intersection / predicted_pixels if predicted_pixels else (
            1.0 if expected_pixels == 0 else 0.0),
        "recall": intersection / expected_pixels if expected_pixels else 1.0,
        "changed_pixels": int(np.count_nonzero(predicted != expected)),
        "predicted_pixels": predicted_pixels,
        "expected_pixels": expected_pixels,
        "intersection": intersection,
        "union": union,
    }


def aggregate(rows: list[dict]) -> dict:
    output = {"cases": len(rows)}
    for layer in LAYERS:
        values = [row["candidate"][layer] for row in rows]
        intersection = sum(value["intersection"] for value in values)
        union = sum(value["union"] for value in values)
        predicted = sum(value["predicted_pixels"] for value in values)
        expected = sum(value["expected_pixels"] for value in values)
        output[layer] = {
            "iou": intersection / union if union else 1.0,
            "precision": intersection / predicted if predicted else (
                1.0 if expected == 0 else 0.0),
            "recall": intersection / expected if expected else 1.0,
        }
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    baseline_report = json.loads(args.baseline.read_text())
    candidate_report = json.loads(args.candidate.read_text())
    asset_manifest = json.loads((args.assets / "manifest.json").read_text())
    if baseline_report["snapshot_id"] != asset_manifest["snapshot_id"]:
        raise ValueError("baseline snapshot does not match corrections")
    if candidate_report["snapshot_id"] != asset_manifest["snapshot_id"]:
        raise ValueError("candidate snapshot does not match corrections")
    if baseline_report["runtime"]["signature"] != asset_manifest["runtime_signature"]:
        raise ValueError("baseline runtime does not match corrections")

    baseline_masks = args.baseline.parent / "masks"
    candidate_masks = args.candidate.parent / "masks"
    rows = []
    for case in asset_manifest["cases"]:
        case_id = case["id"]
        row = {
            "id": case_id,
            "split": case["split"],
            "baseline": {},
            "candidate": {},
        }
        for layer in LAYERS:
            expected = read_mask(args.assets / case_id / f"{layer}.png")
            baseline = read_mask(baseline_masks / f"{case_id}_{layer}.png")
            candidate = read_mask(candidate_masks / f"{case_id}_{layer}.png")
            if baseline.shape != expected.shape or candidate.shape != expected.shape:
                raise ValueError(f"mask shape mismatch for {case_id}/{layer}")
            row["baseline"][layer] = layer_metrics(baseline, expected)
            row["candidate"][layer] = layer_metrics(candidate, expected)
        row["baseline_errors"] = sum(
            row["baseline"][layer]["changed_pixels"] for layer in LAYERS)
        row["candidate_errors"] = sum(
            row["candidate"][layer]["changed_pixels"] for layer in LAYERS)
        row["error_reduction"] = (
            row["baseline_errors"] - row["candidate_errors"])
        row["status"] = (
            "improved" if row["error_reduction"] > 0 else
            "regressed" if row["error_reduction"] < 0 else "tied")
        rows.append(row)

    def status_summary(selected: list[dict]) -> dict:
        return {
            "cases": len(selected),
            "improved": sum(row["status"] == "improved" for row in selected),
            "tied": sum(row["status"] == "tied" for row in selected),
            "regressed": sum(row["status"] == "regressed" for row in selected),
            "baseline_errors": sum(row["baseline_errors"] for row in selected),
            "candidate_errors": sum(row["candidate_errors"] for row in selected),
            "error_reduction": sum(row["error_reduction"] for row in selected),
        }

    result = {
        "schema": "jewelsense.native-correction-evaluation/v1",
        "baseline": str(args.baseline.resolve()),
        "candidate": str(args.candidate.resolve()),
        "assets": str(args.assets.resolve()),
        "summary": {
            "all": {**status_summary(rows), **aggregate(rows)},
            "train": {
                **status_summary([row for row in rows if row["split"] == "train"]),
                **aggregate([row for row in rows if row["split"] == "train"]),
            },
            "holdout": {
                **status_summary([row for row in rows if row["split"] == "holdout"]),
                **aggregate([row for row in rows if row["split"] == "holdout"]),
            },
        },
        "cases": sorted(rows, key=lambda row: (
            row["status"] != "regressed", row["status"] != "tied",
            -abs(row["error_reduction"]), row["id"])),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["summary"], indent=2))


if __name__ == "__main__":
    main()
