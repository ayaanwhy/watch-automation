"""Pluggable background-matting backends.

The pipeline depends only on a tiny contract: a backend exposes
``matte(image_rgb) -> uint8 HxW`` (0 = background, 255 = foreground). Everything
downstream (refine_matte / clean_stencil / anchors / wrap) is backend-agnostic,
so swapping or benchmarking models changes nothing else.

Default backend is BiRefNet (shipped contract, MIT). Additional backends such as
BEN2 are optional: their heavy deps (torch, the model package) are imported lazily
so the slim backend keeps running even when they are not installed.
"""

import importlib.util

import cv2
import numpy as np

from pipeline.background import BackgroundRemover


class BiRefNetBackend:
    name = "birefnet"
    label = "BiRefNet (ONNX, default)"

    def __init__(self, model_path: str, device: str = "auto"):
        self._impl = BackgroundRemover(model_path, device)

    def matte(self, image_rgb: np.ndarray) -> np.ndarray:
        return self._impl.matte(image_rgb)


class Ben2Backend:
    name = "ben2"
    label = "BEN2 (Confidence-Guided Matting)"

    def __init__(self, model_id: str = "PramaLLC/BEN2", device: str = "auto",
                 refine_foreground: bool = False, matte_gamma: float = 1.0,
                 matte_dilate: int = 0):
        import torch
        from ben2 import AutoModel
        from PIL import Image  # noqa: F401  (used in matte)

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self._device = device
        self._refine = bool(refine_foreground)
        self._gamma = float(matte_gamma)
        self._dilate = max(0, int(matte_dilate))
        model = AutoModel.from_pretrained(model_id)
        model.to(torch.device(device)).eval()
        self._model = model

    def _shape(self, matte: np.ndarray) -> np.ndarray:
        """Lift the soft edge band / grow the kept region so thin edges survive
        the shared binary threshold downstream. No-op when gamma==1 and dilate==0."""
        if self._gamma and abs(self._gamma - 1.0) > 1e-3:
            norm = np.clip(matte.astype(np.float32) / 255.0, 0.0, 1.0)
            matte = np.clip(np.power(norm, self._gamma) * 255.0, 0, 255).astype(np.uint8)
        if self._dilate > 0:
            k = cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, (self._dilate * 2 + 1, self._dilate * 2 + 1))
            matte = cv2.dilate(matte, k)
        return matte

    def raw_matte(self, image_rgb: np.ndarray) -> np.ndarray:
        from PIL import Image

        h, w = image_rgb.shape[:2]
        pil = Image.fromarray(image_rgb)
        fg = self._model.inference(pil, refine_foreground=self._refine)
        arr = np.array(fg)
        if arr.ndim == 3 and arr.shape[2] == 4:
            matte = arr[:, :, 3]
        elif arr.ndim == 2:
            matte = arr
        else:
            matte = cv2.cvtColor(arr[:, :, :3], cv2.COLOR_RGB2GRAY)
        if matte.shape[:2] != (h, w):
            matte = cv2.resize(matte, (w, h), interpolation=cv2.INTER_CUBIC)
        return matte.astype(np.uint8)

    def matte(self, image_rgb: np.ndarray) -> np.ndarray:
        return self._shape(self.raw_matte(image_rgb))


def _module_installed(*mods) -> bool:
    return all(importlib.util.find_spec(m) is not None for m in mods)


# Registry: name -> metadata. ``requires`` lists pip modules that must import for
# the backend to be usable; ``available`` is checked without loading any model.
REGISTRY = {
    "birefnet": {
        "label": BiRefNetBackend.label,
        "requires": ["onnxruntime"],
        "note": "MIT. ONNX model set via BIREFNET_MODEL.",
    },
    "ben2": {
        "label": Ben2Backend.label,
        "requires": ["torch", "ben2"],
        "note": "MIT. pip install torch git+https://github.com/PramaLLC/BEN2.git",
    },
}


def availability() -> list:
    out = []
    for name, meta in REGISTRY.items():
        out.append({
            "name": name,
            "label": meta["label"],
            "available": _module_installed(*meta["requires"]),
            "requires": meta["requires"],
            "note": meta["note"],
        })
    return out


def build(name: str, config) -> object:
    """Instantiate a backend by name using values from config.py."""
    name = (name or "").strip().lower()
    if name in ("", "birefnet"):
        return BiRefNetBackend(config.BIREFNET_MODEL, config.GPU_DEVICE)
    if name == "ben2":
        return Ben2Backend(
            config.BEN2_MODEL, config.BEN2_DEVICE, config.BEN2_REFINE,
            getattr(config, "BEN2_MATTE_GAMMA", 1.0),
            getattr(config, "BEN2_MATTE_DILATE", 0),
        )
    raise ValueError(f"unknown background model '{name}'")
