from __future__ import annotations

import os
import sys
import time
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
    candidates.extend([
        base_dir / "models",               # preprocessing/UBG/models/
        base_dir.parent.parent / "models", # <project-root>/models/  (shared location)
        base_dir,                          # preprocessing/UBG/  (legacy fallback)
    ])

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


# Module-level cache, mirroring services/sam_segmenter.py's SAM 2 generator
# cache: the upsampler is built once per (scale_factor, tile, device) and
# reused across every image in the batch instead of being rebuilt from disk
# weights on every call. Keying on tile also keeps the existing CUDA
# OOM-retry-with-smaller-tile path correct, since each tile size gets its
# own cached instance. Reusing the same instance does not change inference
# output — it is the same deterministic model, just constructed once.
_UPSAMPLER: RealESRGANer | None = None
_UPSAMPLER_KEY: tuple[int, int, str, str] | None = None


# Populated during upscale_image() for each real (non-1×) call.
# Read by electron_runner.py after the upscale stage to write to the
# profiling report. Must only be mutated, never rebound, so the imported
# reference in electron_runner.py stays valid.
_last_upscale_diag: dict = {}


def _get_realesrgan_version() -> str:
    try:
        from importlib.metadata import version
        return version("realesrgan")
    except Exception:
        try:
            import pkg_resources
            return pkg_resources.get_distribution("realesrgan").version
        except Exception:
            return "unknown"


def get_last_upscale_diag() -> dict:
    return _last_upscale_diag


def _get_cached_upscaler(
    model_path: Path,
    *,
    device: torch.device,
    tile: int,
    scale_factor: int,
) -> RealESRGANer:
    global _UPSAMPLER, _UPSAMPLER_KEY
    key = (scale_factor, tile, device.type, str(model_path))
    if _UPSAMPLER is not None and _UPSAMPLER_KEY == key:
        return _UPSAMPLER
    _UPSAMPLER = _create_upscaler(model_path, device=device, tile=tile, scale_factor=scale_factor)
    _UPSAMPLER_KEY = key
    return _UPSAMPLER


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

    # ── Diagnostic setup ──────────────────────────────────────────────────────
    # Clear previous run's data; use .clear() + .update() (never rebind) so
    # the reference imported by electron_runner.py stays valid.
    _last_upscale_diag.clear()
    _last_upscale_diag["version_torch"] = torch.__version__
    _last_upscale_diag["version_realesrgan"] = _get_realesrgan_version()
    _last_upscale_diag["scale_factor"] = scale_factor

    # ── Model path resolution ─────────────────────────────────────────────────
    _t = time.perf_counter()
    model_path = _resolve_model_path(scale_factor)
    _last_upscale_diag["t_model_path_ms"] = int((time.perf_counter() - _t) * 1000)
    _last_upscale_diag["model_path"] = str(model_path)

    # ── Image decode ──────────────────────────────────────────────────────────
    _t = time.perf_counter()
    image = _load_image_array(input_path)
    _last_upscale_diag["t_image_decode_ms"] = int((time.perf_counter() - _t) * 1000)
    _last_upscale_diag["input_shape"] = image.shape  # (H, W, 3) numpy BGR

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    # ── Device selection ──────────────────────────────────────────────────────
    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    try:
        _mps_available = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    except Exception:
        _mps_available = False
    _last_upscale_diag["device_selected"] = device.type
    _last_upscale_diag["cuda_available"] = torch.cuda.is_available()
    _last_upscale_diag["mps_available"] = _mps_available
    # Flag the case where MPS is present but the upscaler falls back to CPU —
    # this is the expected outcome with the current code and the likely cause
    # of slow upscale times on Apple Silicon.
    _last_upscale_diag["unexpected_cpu"] = _mps_available and device.type == "cpu"

    tiles_to_try = [UPSCALE.tile]
    if device.type == "cuda":
        tiles_to_try.extend(UPSCALE.tile_fallbacks)

    last_error: Exception | None = None
    for tile in tiles_to_try:
        try:
            # ── Cache lookup / model build ─────────────────────────────────────
            _cache_key = (scale_factor, tile, device.type, str(model_path))
            _cache_hit = _UPSAMPLER is not None and _UPSAMPLER_KEY == _cache_key
            _t = time.perf_counter()
            upsampler = _get_cached_upscaler(model_path, device=device, tile=tile, scale_factor=scale_factor)
            _last_upscale_diag["t_cache_lookup_ms"] = int((time.perf_counter() - _t) * 1000)
            _last_upscale_diag["cache_hit"] = _cache_hit
            _last_upscale_diag["tile_size"] = tile

            # ── Model metadata ─────────────────────────────────────────────────
            try:
                _p = next(upsampler.model.parameters())
                _last_upscale_diag["model_param_device"] = str(_p.device)
                _last_upscale_diag["model_param_dtype"] = str(_p.dtype)
            except Exception:
                _last_upscale_diag["model_param_device"] = "unknown"
                _last_upscale_diag["model_param_dtype"] = "unknown"
            _last_upscale_diag["fp16_enabled"] = getattr(upsampler, "half", False)

            # ── Inference ─────────────────────────────────────────────────────
            # enhance() bundles: tensor construction, tiled or full-image forward
            # pass(es), and numpy conversion. These cannot be individually timed
            # without patching RealESRGANer internals.
            print(f"Running Real-ESRGAN... (tile={tile}, device={device.type.upper()})", file=sys.stderr)
            _t = time.perf_counter()
            result, _ = upsampler.enhance(image, outscale=scale_factor)
            _last_upscale_diag["t_enhance_ms"] = int((time.perf_counter() - _t) * 1000)

            # enhance() always returns a numpy array — output is CPU memory
            # regardless of where the model ran.
            _last_upscale_diag["output_type"] = type(result).__name__
            _last_upscale_diag["output_shape"] = result.shape

            # ── Channel flip (view only, ~0 ms) ───────────────────────────────
            output_rgb = result[:, :, ::-1]

            # ── PNG encode ────────────────────────────────────────────────────
            _t = time.perf_counter()
            Image.fromarray(output_rgb).save(output_file)
            _last_upscale_diag["t_encode_ms"] = int((time.perf_counter() - _t) * 1000)

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
