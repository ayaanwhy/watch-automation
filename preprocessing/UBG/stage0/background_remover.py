from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter
from safetensors.torch import load_file
from torchvision import transforms

from config import ANALYSIS, EDGE, MASK, PIPELINE


MODEL_FILENAME = "BiRefNet_dynamic.safetensors"
MODEL_CODE_FILENAME = "birefnet.py"
MODEL_CONFIG_FILENAME = "BiRefNet_config.py"


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    return Image.fromarray(np.clip(255.0 * image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8))


def _hex_to_rgba(hex_color: str) -> tuple[int, int, int, int]:
    value = hex_color.lstrip("#")
    if len(value) == 6:
        return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4)) + (255,)
    if len(value) == 8:
        return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4, 6))
    raise ValueError("Invalid background_color. Use #RRGGBB or #RRGGBBAA.")


def _refine_foreground(image_rgb: Image.Image, mask: Image.Image) -> Image.Image:
    image_np = np.asarray(image_rgb, dtype=np.float32) / 255.0
    mask_np = np.asarray(mask, dtype=np.float32) / 255.0
    mask_binary = (mask_np > 0.45).astype(np.float32)
    transition_mask = (mask_np > 0.05) & (mask_np < 0.95)
    edge_region = (mask_np > 0.2) & (mask_np < 0.8)
    blurred = mask.filter(ImageFilter.GaussianBlur(radius=1.0))
    blurred_np = np.asarray(blurred, dtype=np.float32) / 255.0
    refined_mask = np.where(transition_mask, 0.85 * mask_np + 0.15 * blurred_np, mask_binary)
    refined_mask = np.where(edge_region, refined_mask * 0.98, refined_mask)
    refined_fg = np.clip(image_np * refined_mask[..., None], 0.0, 1.0)
    return Image.fromarray((refined_fg * 255.0).astype(np.uint8))


# Phase 11.5A additions — ported from the /bg remove reference, both are
# true no-ops at their MASK.* default values (contrast=1.0, antialias_scale=1)
# so existing output is unchanged unless a preset (Phase 11.5B) opts in.
def _adjust_mask_contrast(mask: Image.Image, contrast: float) -> Image.Image:
    contrast = max(0.0, float(contrast))
    if contrast == 1.0:
        return mask
    return mask.point(lambda px: max(0, min(255, int(128 + contrast * (px - 128)))))


def _antialias_mask(mask: Image.Image, scale: int) -> Image.Image:
    scale = max(1, int(scale))
    if scale == 1:
        return mask
    width, height = mask.size
    large = mask.resize((width * scale, height * scale), Image.Resampling.LANCZOS)
    return large.resize((width, height), Image.Resampling.LANCZOS)


def _apply_edge_finish(
    image: Image.Image,
    edge_mode: str = "none",
    edge_strength: float = 1.0,
    alpha_sharpen: float = 0.0,
) -> Image.Image:
    edge_mode = edge_mode.lower().strip()
    if edge_mode == "none":
        return image

    edge_strength = max(0.1, float(edge_strength))
    rgba = image.convert("RGBA")
    rgb = rgba.convert("RGB")
    alpha = rgba.getchannel("A")

    # Change these blocks if you want a stronger or softer edge finish.
    if edge_mode == "sharpen":
        sharpened_rgb = rgb.filter(
            ImageFilter.UnsharpMask(
                radius=1.5 * edge_strength,
                percent=int(150 * edge_strength),
                threshold=3,
            )
        )
        sharpened_alpha = alpha.filter(
            ImageFilter.UnsharpMask(
                radius=1.0 * edge_strength,
                percent=int(120 * edge_strength),
                threshold=2,
            )
        )
        return Image.merge("RGBA", (*sharpened_rgb.split(), sharpened_alpha))

    if edge_mode == "crisp":
        # Phase 11.5A: new option, additive — does not change "sharpen"
        # above. Same RGB sharpening as "sharpen", but alpha-channel
        # sharpening is a separate, independently-tunable control
        # (alpha_sharpen) rather than being tied to edge_strength.
        sharpened_rgb = rgb.filter(
            ImageFilter.UnsharpMask(
                radius=1.5 * edge_strength,
                percent=int(150 * edge_strength),
                threshold=3,
            )
        )
        sharpened_alpha = alpha
        alpha_sharpen = max(0.0, float(alpha_sharpen))
        if alpha_sharpen > 0:
            sharpened_alpha = alpha.filter(
                ImageFilter.UnsharpMask(
                    radius=0.8 * alpha_sharpen,
                    percent=int(120 * alpha_sharpen),
                    threshold=2,
                )
            )
        return Image.merge("RGBA", (*sharpened_rgb.split(), sharpened_alpha))

    if edge_mode == "soften":
        softened_rgb = rgb.filter(ImageFilter.GaussianBlur(radius=0.8 * edge_strength))
        softened_alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.6 * edge_strength))
        return Image.merge("RGBA", (*softened_rgb.split(), softened_alpha))

    raise ValueError("Invalid edge_mode. Use 'none', 'sharpen', 'crisp', or 'soften'.")


class BackgroundRemover:
    def __init__(
        self,
        model_root: str | os.PathLike | None = None,
        # Phase 11.5B: preset-controlled — defaults to ANALYSIS.longest_side
        # (config.py) when not given, matching pre-11.5B behavior for any
        # caller that doesn't pass this explicitly.
        analysis_longest_side: int | None = None,
    ):
        # Priority: CUDA (NVIDIA) → MPS (Apple Silicon) → CPU
        if torch.cuda.is_available():
            self.device = torch.device("cuda")
        elif torch.backends.mps.is_available():
            self.device = torch.device("mps")
        else:
            self.device = torch.device("cpu")
        print(f"Device: {self.device.type.upper()}", file=sys.stderr)
        self.model_root = self._resolve_model_root(model_root)
        self.analysis_longest_side = (
            ANALYSIS.longest_side if analysis_longest_side is None else analysis_longest_side
        )
        self.model = None
        torch.set_float32_matmul_precision("high")
        self._load_model_once()

    def _resolve_model_root(self, model_root: str | os.PathLike | None) -> Path:
        base_dir = Path(__file__).resolve().parent
        candidates = []
        if model_root is not None:
            candidates.append(Path(model_root))
        candidates.extend([base_dir / "BiRefNet", base_dir])

        missing = []
        for candidate in candidates:
            model_path = candidate / MODEL_FILENAME
            code_path = candidate / MODEL_CODE_FILENAME
            config_path = candidate / MODEL_CONFIG_FILENAME
            if model_path.exists() and code_path.exists() and config_path.exists():
                return candidate
            missing.append(candidate)

        raise FileNotFoundError(
            "Missing BiRefNet files. Expected BiRefNet_dynamic.safetensors, birefnet.py, "
            "and BiRefNet_config.py in stage0/BiRefNet or the provided model_root."
        )

    def _dynamic_import(self, module_name: str, path: Path):
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Could not load module from {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module

    def _load_model_once(self) -> None:
        config_module = self._dynamic_import("BiRefNet_config", self.model_root / MODEL_CONFIG_FILENAME)
        model_module = self._dynamic_import("birefnet", self.model_root / MODEL_CODE_FILENAME)

        self.model = model_module.BiRefNet(config_module.BiRefNetConfig())
        state_dict = load_file(self.model_root / MODEL_FILENAME)
        self.model.load_state_dict(state_dict)
        self.model.eval()
        self.model.half()
        self.model.to(self.device)

    def _preprocess(self, image: Image.Image) -> tuple[torch.Tensor, int, int]:
        image = image.convert("RGB")
        width, height = image.size
        # Phase 11.5A: adaptive analysis resolution — capped at
        # self.analysis_longest_side (Phase 11.5B: preset-controlled), but
        # never exceeding the source image's own longest side, rounded to a
        # multiple of ANALYSIS.size_multiple (required for BiRefNet's
        # internal downsampling; not preset-controlled — constant across all
        # presets). Previously fixed at 1024x1024 regardless of input size.
        longest = max(width, height)
        target = min(self.analysis_longest_side, longest)
        size_multiple = max(1, int(ANALYSIS.size_multiple))
        target = max(size_multiple, (target // size_multiple) * size_multiple)
        transform_image = transforms.Compose(
            [
                transforms.Resize((target, target), interpolation=transforms.InterpolationMode.BICUBIC),
                transforms.ToTensor(),
                transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
            ]
        )
        tensor = transform_image(image).unsqueeze(0).to(self.device).half()
        return tensor, width, height

    def remove_background(
        self,
        image: Image.Image | str | os.PathLike,
        *,
        # Change MASK.* in config.py if you want a different baseline edge/mask look.
        mask_blur: int = MASK.blur,
        mask_offset: int = MASK.offset,
        # Phase 11.5A additions — see MaskConfig in config.py for defaults/docs.
        mask_threshold: float | None = MASK.threshold,
        mask_contrast: float = MASK.contrast,
        mask_antialias_scale: int = MASK.antialias_scale,
        invert_output: bool = False,
        refine_foreground: bool = False,
        # Set EDGE.* in config.py to change the default edge finish.
        edge_mode: str = EDGE.mode,
        edge_strength: float = EDGE.strength,
        # Phase 11.5A addition — only affects edge_mode="crisp".
        alpha_sharpen: float = EDGE.alpha_sharpen,
        background: str = PIPELINE.background,
        background_color: str = PIPELINE.background_color,
        artifact_name: str = "object",
    ) -> Image.Image:
        if self.model is None:
            self._load_model_once()

        if not isinstance(image, Image.Image):
            try:
                image = Image.open(image)
            except (FileNotFoundError, OSError) as exc:
                raise ValueError(f"Invalid image file: {image}") from exc

        input_tensor, width, height = self._preprocess(image)

        try:
            with torch.inference_mode():
                preds = self.model(input_tensor)
                pred = preds[-1].sigmoid().cpu()
        except torch.cuda.OutOfMemoryError as exc:
            raise RuntimeError("CUDA out of memory while running BiRefNet inference.") from exc

        pred = pred[0].squeeze()
        pred_pil = transforms.ToPILImage()(pred)
        mask = pred_pil.resize((width, height), Image.BICUBIC)

        # Phase 11.5A: threshold runs first (binarize before smoothing),
        # matching the reference ordering. blur/offset stay in their existing
        # relative order, unchanged from before this phase. contrast/
        # antialias run after, before invert — both are true no-ops at their
        # MASK.* default values (1.0 / 1), so this insertion doesn't change
        # existing output when unconfigured.
        if mask_threshold is not None:
            threshold_value = max(0.0, min(1.0, float(mask_threshold)))
            mask = mask.point(lambda px: 255 if (px / 255.0) >= threshold_value else 0)
        if mask_blur > 0:
            mask = mask.filter(ImageFilter.GaussianBlur(radius=mask_blur))
        if mask_offset > 0:
            for _ in range(mask_offset):
                mask = mask.filter(ImageFilter.MaxFilter(3))
        elif mask_offset < 0:
            for _ in range(-mask_offset):
                mask = mask.filter(ImageFilter.MinFilter(3))
        mask = _adjust_mask_contrast(mask, mask_contrast)
        mask = _antialias_mask(mask, mask_antialias_scale)
        if invert_output:
            mask = Image.fromarray(255 - np.asarray(mask))

        rgba = image.convert("RGBA")
        r, g, b, _ = rgba.split()
        if refine_foreground:
            rgb = _refine_foreground(image.convert("RGB"), mask)
            r, g, b = rgb.split()
        foreground = Image.merge("RGBA", (r, g, b, mask))

        if background == "Alpha":
            finished = _apply_edge_finish(
                foreground, edge_mode=edge_mode, edge_strength=edge_strength, alpha_sharpen=alpha_sharpen
            )
            return finished

        bg = Image.new("RGBA", image.size, _hex_to_rgba(background_color))
        finished = Image.alpha_composite(bg, foreground)
        finished = _apply_edge_finish(
            finished, edge_mode=edge_mode, edge_strength=edge_strength, alpha_sharpen=alpha_sharpen
        )
        return finished


def remove_background(
    image_path: str | os.PathLike,
    model_root: str | os.PathLike | None = None,
    *,
    # Change MASK.* in config.py if you want a different baseline edge/mask look.
    mask_blur: int = MASK.blur,
    mask_offset: int = MASK.offset,
    mask_threshold: float | None = MASK.threshold,
    mask_contrast: float = MASK.contrast,
    mask_antialias_scale: int = MASK.antialias_scale,
    invert_output: bool = False,
    refine_foreground: bool = False,
    # Set EDGE.* in config.py to change the default edge finish.
    edge_mode: str = EDGE.mode,
    edge_strength: float = EDGE.strength,
    alpha_sharpen: float = EDGE.alpha_sharpen,
    background: str = PIPELINE.background,
    background_color: str = PIPELINE.background_color,
    artifact_name: str = "object",
) -> Image.Image:
    try:
        image = Image.open(image_path)
    except (FileNotFoundError, OSError) as exc:
        raise ValueError(f"Invalid image file: {image_path}") from exc

    remover = BackgroundRemover(model_root=model_root)
    return remover.remove_background(
        image,
        mask_blur=mask_blur,
        mask_offset=mask_offset,
        mask_threshold=mask_threshold,
        mask_contrast=mask_contrast,
        mask_antialias_scale=mask_antialias_scale,
        invert_output=invert_output,
        refine_foreground=refine_foreground,
        edge_mode=edge_mode,
        edge_strength=edge_strength,
        alpha_sharpen=alpha_sharpen,
        background=background,
        background_color=background_color,
        artifact_name=artifact_name,
    )
