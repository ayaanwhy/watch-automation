"""Export a final-layer residual checkpoint to validated ONNX."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
import torch

from vto.layer_refiner import LayerRefiner


class ExportWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, image, full, back):
        return self.model.forward_prepared(image, full, back)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ckpt", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument(
        "--class-thresholds",
        help="recommended to_background,to_front,to_back probabilities")
    parser.add_argument(
        "--action-resize", choices=("probability", "discrete"),
        help="recommended native-resolution action resize strategy")
    parser.add_argument(
        "--min-action-component", type=int,
        help="recommended minimum action component at native resolution")
    args = parser.parse_args()
    recommended_thresholds = None
    if args.class_thresholds:
        recommended_thresholds = tuple(
            float(value) for value in args.class_thresholds.split(","))
        if len(recommended_thresholds) != 3:
            raise ValueError(
                "--class-thresholds must be background,front,back")
        if any(value < 0.0 or value > 1.0
               for value in recommended_thresholds):
            raise ValueError("--class-thresholds values must be in [0, 1]")
    if args.min_action_component is not None and args.min_action_component < 0:
        raise ValueError("--min-action-component must be non-negative")
    checkpoint = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    if checkpoint.get("architecture") != LayerRefiner.architecture:
        raise ValueError("checkpoint is not a final-layer refiner")
    size = int(checkpoint["size"])
    model = LayerRefiner(checkpoint.get("no_change_logit", 4.0),
                         checkpoint.get("action_logit", -4.0)).eval()
    model.load_state_dict(checkpoint["refiner"])
    rgb = torch.rand(1, 3, size, size)
    full = (torch.rand(1, 1, size, size) > 0.3).float()
    back = (torch.rand(1, 1, size, size) > 0.8).float() * full
    x_coord, y_coord = model.coordinates(full)
    image = torch.cat((rgb, x_coord, y_coord), dim=1)
    wrapper = ExportWrapper(model).eval()
    with torch.no_grad():
        expected = wrapper(image, full, back).numpy()

    output = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".layer-refiner-", suffix=".onnx",
                                     dir=os.path.dirname(output))
    os.close(fd)
    try:
        torch.onnx.export(
            wrapper, (image, full, back), temporary,
            input_names=["image", "full", "back"],
            output_names=["action_logits"], opset_version=args.opset,
            do_constant_folding=True,
            dynamic_axes={"image": {0: "batch"}, "full": {0: "batch"},
                          "back": {0: "batch"},
                          "action_logits": {0: "batch"}},
        )
        graph = onnx.load(temporary)
        onnx.checker.check_model(graph)
        metadata = {
            "architecture": LayerRefiner.architecture,
            "source_checkpoint": os.path.abspath(args.ckpt),
            "checkpoint_sha256": sha256(args.ckpt),
            "epoch": checkpoint.get("epoch", ""),
            "size": size,
            "no_change_logit": checkpoint.get("no_change_logit", 4.0),
            "action_logit": checkpoint.get("action_logit", -4.0),
            "image_channels": 5,
            "action_classes": "no_change,to_background,to_front,to_back",
        }
        if recommended_thresholds is not None:
            metadata["recommended_class_thresholds"] = ",".join(
                f"{value:g}" for value in recommended_thresholds)
        if args.action_resize is not None:
            metadata["recommended_action_resize"] = args.action_resize
        if args.min_action_component is not None:
            metadata["recommended_min_action_component"] = int(
                args.min_action_component)
        for key, value in metadata.items():
            prop = graph.metadata_props.add()
            prop.key, prop.value = str(key), str(value)
        onnx.save(graph, temporary)
        session = ort.InferenceSession(temporary,
                                       providers=["CPUExecutionProvider"])
        actual = session.run(None, {
            "image": image.numpy(), "full": full.numpy(), "back": back.numpy()
        })[0]
        error = float(np.max(np.abs(expected - actual)))
        if error > 1e-3:
            raise RuntimeError(f"ONNX parity failed: {error}")
        os.replace(temporary, output)
        temporary = None
        with open(os.path.splitext(output)[0] + ".json", "w") as handle:
            json.dump({**metadata, "onnx_sha256": sha256(output),
                       "onnx_max_abs_error": error}, handle, indent=2)
        print(f"[ok] {output} max abs error {error:.3g}")
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
