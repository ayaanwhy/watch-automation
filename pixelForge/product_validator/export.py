"""Export a reviewed validator checkpoint to an isolated ONNX candidate."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from .isolation import HERE, REPO_ROOT, require_isolation, safe_output
from .manifest import sha256_file
from .model import model_from_checkpoint
from .policy import Thresholds


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument(
        "--output", default="product_validator/exports/product_validator.onnx")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--repetitions", type=int, default=100)
    parser.add_argument("--provider", choices=("auto", "cpu", "cuda"),
                        default="auto")
    return parser.parse_args()


def _providers(mode: str):
    available = ort.get_available_providers()
    if mode == "cuda":
        if "CUDAExecutionProvider" not in available:
            raise SystemExit("onnxruntime CUDAExecutionProvider is unavailable")
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if mode == "auto" and "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def main():
    args = parse_args()
    require_isolation(REPO_ROOT)
    output = safe_output(Path(args.output), HERE / "exports")
    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint = torch.load(
        args.checkpoint, map_location="cpu", weights_only=False)
    model = model_from_checkpoint(checkpoint).eval()
    size = int(checkpoint.get("image_size", 224))
    sample = torch.randn(1, 3, size, size)
    with torch.inference_mode():
        expected = [value.numpy() for value in model(sample)]
    torch.onnx.export(
        model, sample, output, opset_version=args.opset,
        input_names=["image"],
        output_names=["asset_logits", "view_logits", "rotation_logits",
                      "suitable_logit", "quality_logits"],
        dynamic_axes={
            "image": {0: "batch"}, "asset_logits": {0: "batch"},
            "view_logits": {0: "batch"}, "rotation_logits": {0: "batch"},
            "suitable_logit": {0: "batch"},
            "quality_logits": {0: "batch"},
        })
    session = ort.InferenceSession(str(output), providers=_providers(args.provider))
    actual = session.run(None, {"image": sample.numpy()})
    errors = [float(np.max(np.abs(left - right)))
              for left, right in zip(expected, actual)]
    if max(errors) > 1e-4:
        output.unlink(missing_ok=True)
        raise RuntimeError(f"ONNX parity failed: max errors {errors}")
    feed = {"image": sample.numpy()}
    for _ in range(args.warmup):
        session.run(None, feed)
    samples = []
    for _ in range(args.repetitions):
        started = time.perf_counter()
        session.run(None, feed)
        samples.append((time.perf_counter() - started) * 1000.0)
    metadata = {
        "schema_version": 1,
        "onnx": output.name,
        "sha256": sha256_file(output),
        "source_checkpoint": str(Path(args.checkpoint).resolve()),
        "architecture": checkpoint["architecture"],
        "image_size": size,
        "normalization": {
            "mean": [0.485, 0.456, 0.406],
            "std": [0.229, 0.224, 0.225],
            "letterbox_fill": [247, 247, 247],
        },
        "classes": checkpoint["classes"],
        "thresholds": Thresholds().__dict__,
        "manifest_fingerprint": checkpoint.get("manifest_fingerprint"),
        "validation_groups": checkpoint.get("val_groups", []),
        "checkpoint_metrics": checkpoint.get("metrics"),
        "onnx_max_absolute_error": errors,
        "latency_ms": {
            "provider": session.get_providers()[0],
            "median": float(np.median(samples)),
            "p95": float(np.percentile(samples, 95)),
            "mean": float(np.mean(samples)),
            "repetitions": len(samples),
        },
    }
    metadata_path = output.with_suffix(".json")
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    require_isolation(REPO_ROOT)
    print(json.dumps({"onnx": str(output), "metadata": str(metadata_path),
                      "parity_max_error": max(errors),
                      "latency_ms": metadata["latency_ms"]}, indent=2))


if __name__ == "__main__":
    main()
