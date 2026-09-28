#!/usr/bin/env python3
"""Sweep sparse-action thresholds against corrections and identity gates."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import DataLoader

from vto.data import cached_meta, find_cached
from vto.layer_refiner import (LayerRefiner, apply_action_map,
                               apply_layer_actions)
from vto.train_layer_refiner import LayerRefinerPairs, errors_per_sample


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--ckpt", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--threshold", type=float, action="append",
                        default=[])
    parser.add_argument("--class-threshold", action="append", default=[],
                        help="comma-separated background,front,back thresholds")
    parser.add_argument("--min-component", type=int, action="append",
                        default=[])
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--device",
                        default="cuda" if torch.cuda.is_available() else "cpu")
    return parser.parse_args()


def summarize(rows, source=None, split=None):
    selected = [row for row in rows
                if (source is None or row["target_source"] == source) and
                (split is None or row["split"] == split)]
    deltas = [row["baseline_errors"] - row["candidate_errors"]
              for row in selected]
    expected_actions = sum(row["expected_actions"] for row in selected)
    matched_actions = sum(row["matched_actions"] for row in selected)
    predicted_actions = sum(row["predicted_actions"] for row in selected)
    return {
        "cases": len(selected),
        "improved": sum(delta > 0 for delta in deltas),
        "tied": sum(delta == 0 for delta in deltas),
        "regressed": sum(delta < 0 for delta in deltas),
        "changed_cases": sum(row["predicted_actions"] > 0 for row in selected),
        "baseline_errors": sum(row["baseline_errors"] for row in selected),
        "candidate_errors": sum(row["candidate_errors"] for row in selected),
        "expected_actions": expected_actions,
        "predicted_actions": predicted_actions,
        "matched_actions": matched_actions,
        "action_precision": matched_actions / max(predicted_actions, 1),
        "action_recall": matched_actions / max(expected_actions, 1),
    }


def filter_components(actions, min_component):
    if min_component <= 1:
        return actions
    source = actions.numpy()
    filtered = np.zeros_like(source)
    for index in range(len(source)):
        for action_class in (1, 2, 3):
            mask = (source[index] == action_class).astype(np.uint8)
            count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
            for component in range(1, count):
                if stats[component, cv2.CC_STAT_AREA] >= min_component:
                    filtered[index][labels == component] = action_class
    return torch.from_numpy(filtered)


def main():
    args = parse_args()
    checkpoint = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    if checkpoint.get("architecture") != LayerRefiner.architecture:
        raise ValueError("checkpoint is not a final-layer refiner")
    model = LayerRefiner(checkpoint.get("no_change_logit", 4.0),
                         checkpoint.get("action_logit", -4.0))
    model.load_state_dict(checkpoint["refiner"])
    model.to(args.device).eval()
    size = int(checkpoint["size"])
    items = find_cached(args.data)
    dataset = LayerRefinerPairs(items, size=size, train=False,
                                seed=int(checkpoint["args"]["seed"]))
    loader = DataLoader(dataset, batch_size=args.batch, shuffle=False,
                        num_workers=args.workers, pin_memory=True)
    thresholds = list(args.threshold)
    thresholds.extend(tuple(float(value) for value in item.split(","))
                      for item in args.class_threshold)
    if not thresholds:
        thresholds = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95,
                      0.98, 0.99, 0.995, 0.999]
    if any(isinstance(value, tuple) and len(value) != 3
           for value in thresholds):
        raise ValueError("class thresholds require exactly three values")
    components = args.min_component or [0]
    settings = [(threshold, component) for threshold in thresholds
                for component in components]
    rows = {setting: [] for setting in settings}
    names = [Path(item[0]).parent.name for item in items]
    metadata = [cached_meta(item) for item in items]
    cursor = 0
    with torch.no_grad():
        for (rgb, full, back, target_full, target_back, labels,
             _) in loader:
            logits = model(rgb.to(args.device), full.to(args.device),
                           back.to(args.device)).cpu()
            expected_full = target_full > 0.5
            expected_back = target_back > 0.5
            baseline_errors = errors_per_sample(
                full > 0.5, back > 0.5, expected_full, expected_back)
            for threshold in thresholds:
                candidate_full, candidate_back, actions = apply_layer_actions(
                    full, back, logits, threshold=threshold)
                for component in components:
                    filtered = filter_components(actions, component)
                    candidate_full, candidate_back = apply_action_map(
                        full, back, filtered)
                    candidate_errors = errors_per_sample(
                        candidate_full, candidate_back, expected_full,
                        expected_back)
                    for index in range(len(rgb)):
                        predicted = filtered[index]
                        expected = labels[index]
                        rows[(threshold, component)].append({
                            "id": names[cursor + index],
                            "split": metadata[cursor + index].get(
                                "split", "train"),
                            "target_source": metadata[cursor + index].get(
                                "target_source"),
                            "baseline_errors": int(baseline_errors[index]),
                            "candidate_errors": int(candidate_errors[index]),
                            "expected_actions": int((expected != 0).sum()),
                            "predicted_actions": int((predicted != 0).sum()),
                            "matched_actions": int(((predicted == expected) &
                                                    (expected != 0)).sum()),
                            "expected_by_class": {
                                str(action_class): int(
                                    (expected == action_class).sum())
                                for action_class in (1, 2, 3)
                            },
                            "predicted_by_class": {
                                str(action_class): int(
                                    (predicted == action_class).sum())
                                for action_class in (1, 2, 3)
                            },
                        })
            cursor += len(rgb)

    evaluations = []
    for threshold, component in settings:
        current = rows[(threshold, component)]
        evaluations.append({
            "threshold": list(threshold) if isinstance(threshold, tuple)
            else threshold,
            "min_component": component,
            "corrections_all": summarize(
                current, "reviewed_correction"),
            "corrections_train": summarize(
                current, "reviewed_correction", "train"),
            "corrections_holdout": summarize(
                current, "reviewed_correction", "holdout"),
            "identities_all": summarize(current, "reviewed_identity"),
            "rows": current,
        })
    payload = {
        "schema": "jewelsense.layer-refiner-threshold-sweep/v1",
        "checkpoint": str(Path(args.ckpt).resolve()),
        "architecture": checkpoint["architecture"],
        "epoch": checkpoint["epoch"],
        "size": size,
        "evaluations": evaluations,
    }
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n")
    concise = [{
        "threshold": row["threshold"],
        "min_component": row["min_component"],
        "train": {key: row["corrections_train"][key]
                  for key in ("improved", "tied", "regressed",
                              "action_precision", "action_recall")},
        "holdout": {key: row["corrections_holdout"][key]
                    for key in ("improved", "tied", "regressed",
                                "action_precision", "action_recall")},
        "identity": {key: row["identities_all"][key]
                     for key in ("changed_cases", "predicted_actions")},
    } for row in evaluations]
    print(json.dumps(concise, indent=2))


if __name__ == "__main__":
    main()
