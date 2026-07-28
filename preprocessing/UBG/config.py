from __future__ import annotations

from dataclasses import dataclass


# Edit only this file when you want to change the default behavior of the automation.


@dataclass(frozen=True)
class UpscaleConfig:
    # True upscale factor. Use 1, 2, or 4.
    scale_factor: int = 1
    tile: int = 512
    tile_fallbacks: tuple[int, ...] = (256, 128)


@dataclass(frozen=True)
class EdgeConfig:
    # Choose: "none", "sharpen", "crisp", or "soften".
    mode: str = "sharpen"
    strength: float = 1.5
    # Phase 11.5A: independent alpha-channel sharpening for edge_mode="crisp"
    # (does not affect "sharpen", which keeps its existing edge_strength-tied
    # alpha sharpening unchanged). 0.0 = no-op default.
    alpha_sharpen: float = 0.0


@dataclass(frozen=True)
class AnalysisConfig:
    # BiRefNet analysis resolution (Phase 11.5A). The model analyzes the
    # image at this resolution before the mask is resized back up to the
    # original image size — capped at longest_side, but never exceeding the
    # source image's own longest side, so a small input isn't needlessly
    # upscaled before analysis. Previously fixed at 1024x1024 regardless of
    # input size.
    longest_side: int = 1024
    size_multiple: int = 32  # Keep 32 for BiRefNet shape safety.


@dataclass(frozen=True)
class MaskConfig:
    # Tweak the background mask after BiRefNet.
    blur: int = 0
    offset: int = -2
    # Phase 11.5A additions — all default to no-op values so existing output
    # is unchanged unless a preset (Phase 11.5B) opts in.
    threshold: float | None = None  # None keeps smooth edges; e.g. 0.45 makes a hard cut.
    contrast: float = 1.0  # 1.0 = no change; higher firms the edge, lower softens it.
    antialias_scale: int = 1  # 1 = no change; higher supersamples the mask edge smoother.


@dataclass(frozen=True)
class PipelineConfig:
    # Paste a full folder path here, or leave it relative to the project folder.
    input_dir: str = "input"
    output_dir: str = "output"
    temp_dir: str = "temp"
    # Final output filename extension. Use .png for transparency, or .webp if desired.
    output_suffix: str = ".png"
    # PNG metadata DPI value. Change this to 72, 150, 300, etc.
    output_ppi: int = 300
    refine_foreground: bool = False
    background: str = "Alpha"
    background_color: str = "#ffffff"
    # Temporary manual plugin selector until automatic recognition is added.
    object_type: str = "watch"


@dataclass(frozen=True)
class SamConfig:
    checkpoint: str = "models/sam2/sam2.1_hiera_tiny.pt"
    model_config: str = "configs/sam2.1/sam2.1_hiera_t.yaml"
    # Lower values are slower/less detailed but much safer on 4 GB GPUs.
    max_image_size: int = 1024
    points_per_side: int = 32 
    points_per_batch: int = 16
    pred_iou_thresh: float = 0.8
    stability_score_thresh: float = 0.92
    min_mask_region_area: int = 100
    max_masks: int = 32


UPSCALE = UpscaleConfig()
EDGE = EdgeConfig()
ANALYSIS = AnalysisConfig()
MASK = MaskConfig()
PIPELINE = PipelineConfig()
SAM = SamConfig()
