"""Export a trained checkpoint to the artifacts used by ``deploy/serve.py``.

The exporter validates the graph and compares ONNX Runtime with PyTorch before
atomically replacing any destination artifacts.
"""

import argparse
import hashlib
import json
import os
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
import torch

from vto.model import model_from_checkpoint
from vto.provenance import holdout_validity


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", required=True)
    p.add_argument("--outdir", default="deploy")
    p.add_argument("--opset", type=int, default=17)
    return p.parse_args()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_torch_save(value, path):
    fd, tmp = tempfile.mkstemp(prefix=".export-", suffix=".pt",
                               dir=os.path.dirname(os.path.abspath(path)))
    os.close(fd)
    try:
        torch.save(value, tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    args = parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    # onnxruntime 1.29 may create this telemetry-id artifact despite logging
    # that it fell back to an in-memory id. Remove it only when this invocation
    # created it; never touch a pre-existing user file.
    telemetry_artifact = os.path.join(os.getcwd(), ":memory:.ses")
    telemetry_preexisting = os.path.exists(telemetry_artifact)
    checkpoint = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    size = int(checkpoint.get("size", 384))
    model = model_from_checkpoint(checkpoint).eval()

    fd, tmp_onnx = tempfile.mkstemp(prefix=".export-", suffix=".onnx",
                                    dir=os.path.abspath(args.outdir))
    os.close(fd)
    try:
        example = torch.rand(1, 3, size, size)
        with torch.no_grad():
            expected = model(example).numpy()
        torch.onnx.export(
            model, example, tmp_onnx, input_names=["image"], output_names=["masks"],
            opset_version=args.opset, do_constant_folding=True,
            dynamic_axes={"image": {0: "batch"}, "masks": {0: "batch"}},
        )
        graph = onnx.load(tmp_onnx)
        onnx.checker.check_model(graph)
        metadata = {
            "architecture": checkpoint.get("architecture", "ring_unet_v1"),
            "source_checkpoint": os.path.abspath(args.ckpt),
            "checkpoint_sha256": sha256(args.ckpt),
            "epoch": checkpoint.get("epoch", ""),
            "size": size,
            "matte_iou": checkpoint.get("matte_iou", ""),
            "back_iou": checkpoint.get("back_iou", ""),
            "family_back_iou": checkpoint.get("family_back_iou", ""),
            "halo_iou": checkpoint.get("halo_iou", ""),
            "ownership_mode": checkpoint.get("ownership_mode", "legacy"),
        }
        checkpoint_args = checkpoint.get("args") or {}
        init_path = checkpoint_args.get("init")
        validity = holdout_validity(checkpoint, args.ckpt)
        metadata.update({
            "init_checkpoint": init_path or "",
            "validation_strict_holdout": validity["strict_holdout"],
            "validation_holdout_status": validity["status"],
            "validation_provenance_complete": validity["provenance_complete"],
            "pretraining_overlap_designs": validity["pretraining_overlap_designs"],
        })
        del graph.metadata_props[:]
        for key, value in metadata.items():
            prop = graph.metadata_props.add()
            prop.key, prop.value = str(key), str(value)
        onnx.save(graph, tmp_onnx)

        session = ort.InferenceSession(tmp_onnx, providers=["CPUExecutionProvider"])
        actual = session.run(["masks"], {"image": example.numpy()})[0]
        max_error = float(np.max(np.abs(expected - actual)))
        if max_error > 1e-3:
            raise RuntimeError(f"ONNX parity failed: max abs error {max_error:.6g}")

        onnx_path = os.path.join(args.outdir, "model.onnx")
        os.replace(tmp_onnx, onnx_path)
        tmp_onnx = None
        base = {"architecture": checkpoint.get("architecture", "ring_unet_v1"),
                "model": checkpoint["model"], "size": size,
                "ownership_mode": checkpoint.get("ownership_mode", "legacy"),
                "source_checkpoint": os.path.abspath(args.ckpt),
                "checkpoint_sha256": metadata["checkpoint_sha256"]}
        atomic_torch_save(base, os.path.join(args.outdir, "model_fp32.pt"))
        atomic_torch_save({**base, "model": {
            k: (v.half() if torch.is_floating_point(v) else v)
            for k, v in checkpoint["model"].items()}},
                          os.path.join(args.outdir, "model_fp16.pt"))
        with open(os.path.join(args.outdir, "model.json"), "w") as f:
            json.dump({**metadata, "onnx_sha256": sha256(onnx_path),
                       "onnx_max_abs_error": max_error}, f, indent=2)
        print(f"[✓] {onnx_path} ({os.path.getsize(onnx_path) / 1e6:.1f} MB), "
              f"max abs error {max_error:.3g}")
    finally:
        if tmp_onnx and os.path.exists(tmp_onnx):
            os.unlink(tmp_onnx)
        if not telemetry_preexisting and os.path.isfile(telemetry_artifact):
            os.unlink(telemetry_artifact)


if __name__ == "__main__":
    main()
