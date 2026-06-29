from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import numpy as np
from PIL import Image
import torch

from config import PIPELINE, UPSCALE

try:
    from torchvision.transforms.functional import rgb_to_grayscale
except ImportError as exc:  # pragma: no cover - depends on installed torchvision
    raise ImportError("TorchVision is missing rgb_to_grayscale.") from exc

functional_tensor = types.ModuleType("torchvision.transforms.functional_tensor")
functional_tensor.rgb_to_grayscale = rgb_to_grayscale
sys.modules.setdefault("torchvision.transforms.functional_tensor", functional_tensor)

try:
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan import RealESRGANer
except ImportError as exc:  # pragma: no cover - surfaced at runtime
    raise ImportError(
        "Real-ESRGAN dependencies are missing. Install realesrgan and basicsr."
    ) from exc


MODEL_FILENAMES = {
    1: None,
    2: "RealESRGAN_x2plus.pth",
    4: "RealESRGAN_x4plus.pth",
}


def _resolve_model_path(scale_factor: int, model_root: str | os.PathLike | None = None) -> Path:
    base_dir = Path(__file__).resolve().parents[1]
    candidates = []
    if model_root is not None:
        candidates.append(Path(model_root))
    candidates.extend([base_dir / "models", base_dir])

    model_filename = MODEL_FILENAMES.get(scale_factor)
    if model_filename is None:
        if scale_factor == 1:
            raise ValueError("No model is needed for scale_factor=1.")
        raise ValueError("Unsupported scale_factor. Use 1, 2, or 4.")

    for candidate in candidates:
        model_path = candidate / model_filename
        if model_path.exists():
            return model_path

    raise FileNotFoundError(
        f"Missing Real-ESRGAN model. Expected {model_filename} in models/."
    )


def _load_image_array(input_path: str | os.PathLike) -> np.ndarray:
    try:
        with Image.open(input_path) as image:
            image_rgb = np.array(image.convert("RGB"))
            return image_rgb[:, :, ::-1]
    except (FileNotFoundError, OSError) as exc:
        raise ValueError(f"Invalid image file: {input_path}") from exc


def _create_upscaler(
    model_path: Path,
    *,
    device: torch.device,
    tile: int,
    scale_factor: int,
) -> RealESRGANer:
    model = RRDBNet(
        num_in_ch=3,
        num_out_ch=3,
        num_feat=64,
        num_block=23,
        num_grow_ch=32,
        scale=scale_factor,
    )
    half = device.type == "cuda"
    return RealESRGANer(
        scale=scale_factor,
        model_path=str(model_path),
        model=model,
        tile=tile,
        tile_pad=10,
        pre_pad=0,
        half=half,
        device=device,
    )


def upscale_image(input_path: str, output_path: str, *, scale_factor: int | None = None) -> str:
    # Change UPSCALE.scale_factor in config.py if you want a true 1x, 2x, or 4x upscale.
    scale_factor = UPSCALE.scale_factor if scale_factor is None else scale_factor
    if scale_factor == 1:
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(input_path) as image:
            image.save(output_file, dpi=(PIPELINE.output_ppi, PIPELINE.output_ppi))
        print("Upscaling skipped (1x).", file=sys.stderr)
        return str(output_file)

    model_path = _resolve_model_path(scale_factor)
    image = _load_image_array(input_path)

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    tiles_to_try = [UPSCALE.tile]
    if device.type == "cuda":
        tiles_to_try.extend(UPSCALE.tile_fallbacks)

    last_error: Exception | None = None
    for tile in tiles_to_try:
        try:
            upsampler = _create_upscaler(model_path, device=device, tile=tile, scale_factor=scale_factor)
            print(f"Running Real-ESRGAN... (tile={tile}, device={device.type.upper()})", file=sys.stderr)
            result, _ = upsampler.enhance(image, outscale=scale_factor)
            output_bgr = result
            output_rgb = output_bgr[:, :, ::-1]
            Image.fromarray(output_rgb).save(output_file)
            print("Upscaling complete.", file=sys.stderr)
            return str(output_file)
        except torch.cuda.OutOfMemoryError as exc:
            last_error = exc
            if device.type != "cuda":
                break
            print(f"CUDA OOM at tile={tile}; retrying with smaller tiles.", file=sys.stderr)
            torch.cuda.empty_cache()
        except Exception as exc:
            last_error = exc
            if device.type == "cuda" and "out of memory" in str(exc).lower():
                print(f"CUDA OOM at tile={tile}; retrying with smaller tiles.", file=sys.stderr)
                torch.cuda.empty_cache()
                continue
            break

    if isinstance(last_error, torch.cuda.OutOfMemoryError) or (
        last_error is not None and "out of memory" in str(last_error).lower()
    ):
        raise RuntimeError(
            "CUDA out of memory while running Real-ESRGAN, even after retries."
        ) from last_error
    if last_error is not None:
        raise last_error
    raise RuntimeError("Real-ESRGAN upscaling failed for an unknown reason.")
