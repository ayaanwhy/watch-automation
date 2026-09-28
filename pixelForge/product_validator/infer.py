"""Run a standalone ONNX validator and apply its API decision policy."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

from .policy import Thresholds, decide
from .taxonomy import (ASSET_CLASSES, QUALITY_FLAGS, ROTATION_CLASSES,
                       VIEW_CLASSES)


def _softmax(values):
    values = values - np.max(values)
    values = np.exp(values)
    return values / values.sum()


def _sigmoid(values):
    return 1.0 / (1.0 + np.exp(-values))


def prepare_image(path: Path, size: int) -> np.ndarray:
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened)
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            ground = Image.new("RGBA", rgba.size, (247, 247, 247, 255))
            image = Image.alpha_composite(ground, rgba).convert("RGB")
        else:
            image = image.convert("RGB")
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (size, size), (247, 247, 247))
        canvas.paste(image, ((size - image.width) // 2,
                             (size - image.height) // 2))
    value = np.asarray(canvas, dtype=np.float32) / 255.0
    value = (value - np.asarray((0.485, 0.456, 0.406), np.float32))
    value /= np.asarray((0.229, 0.224, 0.225), np.float32)
    return np.transpose(value, (2, 0, 1))[None]


def probabilities_from_logits(outputs) -> dict:
    asset, view, rotation, suitable, quality = outputs
    asset = _softmax(asset[0])
    view = _softmax(view[0])
    rotation = _softmax(rotation[0])
    suitable = float(_sigmoid(suitable.reshape(-1)[0]))
    quality = _sigmoid(quality[0])
    return {
        "asset": {name: float(asset[index])
                  for index, name in enumerate(ASSET_CLASSES)},
        "view": {name: float(view[index])
                 for index, name in enumerate(VIEW_CLASSES)},
        "rotation": {name: float(rotation[index])
                     for index, name in enumerate(ROTATION_CLASSES)},
        "suitable": suitable,
        "quality": {name: float(quality[index])
                    for index, name in enumerate(QUALITY_FLAGS)},
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--model", required=True)
    parser.add_argument("--expected-asset", choices=("ring", "gemstone"),
                        required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    model = Path(args.model).resolve()
    metadata_path = model.with_suffix(".json")
    metadata = json.loads(metadata_path.read_text())
    if metadata.get("sha256"):
        from .manifest import sha256_file
        if sha256_file(model) != metadata["sha256"]:
            raise SystemExit("validator ONNX checksum does not match metadata")
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    image = prepare_image(Path(args.image), int(metadata["image_size"]))
    probabilities = probabilities_from_logits(
        session.run(None, {session.get_inputs()[0].name: image}))
    threshold_values = metadata.get("thresholds", {})
    result = decide(probabilities, args.expected_asset,
                    Thresholds(**threshold_values))
    result["probabilities"] = probabilities
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
