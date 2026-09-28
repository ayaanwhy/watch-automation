"""Benchmark an exported ONNX validator on a labeled manifest holdout."""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .dataset import label_index, manifest_fingerprint
from .infer import prepare_image
from .isolation import HERE, REPO_ROOT, require_isolation, safe_output
from .metrics import binary_report, classification_report, quality_report
from .manifest import load_manifest, resolve_image, sha256_file
from .policy import Thresholds, decide
from .taxonomy import (ASSET_CLASSES, QUALITY_FLAGS, ROTATION_CLASSES,
                       VIEW_CLASSES)


def _softmax(values):
    shifted = values - values.max(axis=1, keepdims=True)
    values = np.exp(shifted)
    return values / values.sum(axis=1, keepdims=True)


def _sigmoid(values):
    return 1.0 / (1.0 + np.exp(-values))


def _targets(cases):
    asset, view, rotation, suitable, quality = [], [], [], [], []
    for case in cases:
        labels = case["labels"]
        asset.append(label_index(labels.get("asset"), ASSET_CLASSES))
        view.append(label_index(labels.get("view"), VIEW_CLASSES))
        rotation.append(label_index(
            labels.get("rotation"), ROTATION_CLASSES))
        value = labels.get("suitable")
        suitable.append(-1.0 if value is None else float(value))
        flags = labels.get("quality")
        quality.append(([-1.0] * len(QUALITY_FLAGS) if flags is None else
                        [float(flag in flags) for flag in QUALITY_FLAGS]))
    return (np.asarray(asset), np.asarray(view), np.asarray(rotation),
            np.asarray(suitable), np.asarray(quality))


def _probability_dict(asset, view, rotation, suitable, quality):
    return {
        "asset": dict(zip(ASSET_CLASSES, map(float, asset))),
        "view": dict(zip(VIEW_CLASSES, map(float, view))),
        "rotation": dict(zip(ROTATION_CLASSES, map(float, rotation))),
        "suitable": float(suitable),
        "quality": dict(zip(QUALITY_FLAGS, map(float, quality))),
    }


def _decision_report(cases, asset, view, rotation, suitable, quality,
                     thresholds):
    statuses = Counter()
    false_rejections = []
    unsafe_accepts = []
    incorrect_corrections = []
    evaluated = 0
    for index, case in enumerate(cases):
        labels = case["labels"]
        product = labels.get("asset")
        if product not in ("ring", "gemstone", "other"):
            continue
        if labels.get("suitable") is None or labels.get("quality") is None:
            continue
        expected = product if product in ("ring", "gemstone") else "ring"
        result = decide(_probability_dict(
            asset[index], view[index], rotation[index], suitable[index],
            quality[index]),
            expected, thresholds)
        statuses[result["status"]] += 1
        rotation_label = labels.get("rotation")
        valid = (product in ("ring", "gemstone") and
                 labels.get("view") == "front" and
                 rotation_label in ROTATION_CLASSES and
                 labels["suitable"] is True and not labels["quality"])
        expected_status = ("accepted" if rotation_label == "none" else
                           "correctable")
        predicted_rotation = (result.get("correction") or {}).get("operation")
        wrong_correction = (
            valid and result["status"] == "correctable" and
            predicted_rotation != rotation_label)
        if wrong_correction:
            incorrect_corrections.append({
                "id": case["id"], "expected": rotation_label,
                "predicted": predicted_rotation})
        if valid and result["status"] != expected_status:
            false_rejections.append({"id": case["id"],
                                     "decision": result["status"],
                                     "code": result["code"]})
        unsafe_orientation = (wrong_correction or
                              (valid and result["status"] == "accepted" and
                               rotation_label != "none"))
        if ((not valid or unsafe_orientation) and
                result["status"] in ("accepted", "correctable")):
            unsafe_accepts.append({"id": case["id"],
                                   "code": result["code"]})
        evaluated += 1
    return {
        "evaluated": evaluated,
        "statuses": dict(statuses),
        "false_rejection_count": len(false_rejections),
        "unsafe_accept_count": len(unsafe_accepts),
        "false_rejections": false_rejections,
        "unsafe_accepts": unsafe_accepts,
        "incorrect_correction_count": len(incorrect_corrections),
        "incorrect_corrections": incorrect_corrections,
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--split", choices=("validation", "all"),
                        default="validation")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--provider", choices=("auto", "cpu", "cuda"),
                        default="auto")
    parser.add_argument("--output")
    return parser.parse_args()


def main():
    args = parse_args()
    require_isolation(REPO_ROOT)
    model_path = Path(args.model).resolve()
    metadata = json.loads(model_path.with_suffix(".json").read_text())
    if sha256_file(model_path) != metadata["sha256"]:
        raise SystemExit("validator ONNX checksum does not match metadata")
    manifest_path = Path(args.manifest).resolve()
    manifest = load_manifest(manifest_path)
    if manifest_fingerprint(manifest) != metadata["manifest_fingerprint"]:
        raise SystemExit("manifest differs from the exported model manifest")
    cases = manifest["cases"]
    if args.split == "validation":
        groups = set(metadata.get("validation_groups", ()))
        if not groups:
            raise SystemExit("export metadata has no validation groups")
        cases = [case for case in cases if case["group_id"] in groups]
    if not cases:
        raise SystemExit("selected benchmark split is empty")

    available = ort.get_available_providers()
    if args.provider == "cuda" and "CUDAExecutionProvider" not in available:
        raise SystemExit("onnxruntime CUDAExecutionProvider is unavailable")
    providers = (["CUDAExecutionProvider", "CPUExecutionProvider"]
                 if args.provider in ("auto", "cuda") and
                 "CUDAExecutionProvider" in available else
                 ["CPUExecutionProvider"])
    session = ort.InferenceSession(str(model_path), providers=providers)
    input_name = session.get_inputs()[0].name
    size = int(metadata["image_size"])
    outputs = [[], [], [], [], []]
    preprocess_ms, inference_ms = [], []
    for start in range(0, len(cases), args.batch_size):
        chunk = cases[start:start + args.batch_size]
        before = time.perf_counter()
        images = np.concatenate([
            prepare_image(resolve_image(manifest_path, manifest, case), size)
            for case in chunk], axis=0)
        after_preprocess = time.perf_counter()
        batch_outputs = session.run(None, {input_name: images})
        after_inference = time.perf_counter()
        preprocess_ms.append((after_preprocess - before) * 1000 / len(chunk))
        inference_ms.append(
            (after_inference - after_preprocess) * 1000 / len(chunk))
        for target, values in zip(outputs, batch_outputs):
            target.append(values)
    (asset_logits, view_logits, rotation_logits, suitable_logits,
     quality_logits) = [
        np.concatenate(values) for values in outputs]
    asset_probability = _softmax(asset_logits)
    view_probability = _softmax(view_logits)
    rotation_probability = _softmax(rotation_logits)
    suitable_probability = _sigmoid(suitable_logits.reshape(-1))
    quality_probability = _sigmoid(quality_logits)
    (asset_target, view_target, rotation_target, suitable_target,
     quality_target) = _targets(cases)
    thresholds = Thresholds(**metadata.get("thresholds", {}))
    report = {
        "model": str(model_path), "manifest": str(manifest_path),
        "split": args.split, "case_count": len(cases),
        "provider": session.get_providers()[0],
        "latency_ms_per_image": {
            "preprocess_mean": float(np.mean(preprocess_ms)),
            "inference_mean": float(np.mean(inference_ms)),
            "combined_mean": float(np.mean(preprocess_ms) +
                                   np.mean(inference_ms)),
        },
        "metrics": {
            "asset": classification_report(
                asset_target, asset_probability, ASSET_CLASSES),
            "view": classification_report(
                view_target, view_probability, VIEW_CLASSES),
            "rotation": classification_report(
                rotation_target, rotation_probability, ROTATION_CLASSES),
            "suitable": binary_report(
                suitable_target, suitable_probability),
            "quality": quality_report(
                quality_target, quality_probability, QUALITY_FLAGS),
        },
        "policy": _decision_report(
            cases, asset_probability, view_probability, rotation_probability,
            suitable_probability, quality_probability, thresholds),
    }
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        output = safe_output(Path(args.output), HERE / "runs")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
