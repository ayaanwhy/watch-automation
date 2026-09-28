"""Export an ownership residual checkpoint to validated ONNX."""

import argparse
import hashlib
import json
import os
import tempfile

import numpy as np
import onnx
import onnxruntime as ort
import torch

from vto.ownership_refiner import OwnershipRefiner


class ExportWrapper(torch.nn.Module):
    """Keep coordinate construction out of the GPU-only ONNX graph."""

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
    args = parser.parse_args()
    checkpoint = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    if checkpoint.get("architecture") != OwnershipRefiner.architecture:
        raise ValueError("checkpoint is not an ownership refiner")
    size = int(checkpoint["size"])
    model = OwnershipRefiner(checkpoint.get("no_edit_logit", -6.0)).eval()
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
    fd, temporary = tempfile.mkstemp(prefix=".ownership-refiner-",
                                     suffix=".onnx",
                                     dir=os.path.dirname(output))
    os.close(fd)
    try:
        torch.onnx.export(
            wrapper, (image, full, back), temporary,
            input_names=["image", "full", "back"],
            output_names=["back_logits"], opset_version=args.opset,
            do_constant_folding=True,
            dynamic_axes={"image": {0: "batch"}, "full": {0: "batch"},
                          "back": {0: "batch"}, "back_logits": {0: "batch"}},
        )
        graph = onnx.load(temporary)
        onnx.checker.check_model(graph)
        metadata = {
            "architecture": OwnershipRefiner.architecture,
            "source_checkpoint": os.path.abspath(args.ckpt),
            "checkpoint_sha256": sha256(args.ckpt),
            "epoch": checkpoint.get("epoch", ""),
            "size": size,
            "no_edit_logit": checkpoint.get("no_edit_logit", -6.0),
            "image_channels": 5,
        }
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
