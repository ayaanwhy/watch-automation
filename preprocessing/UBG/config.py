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
    # Choose: "none", "sharpen", or "soften".
    mode: str = "sharpen"
    strength: float = 1


@dataclass(frozen=True)
class MaskConfig:
    # Tweak the background mask after BiRefNet.
    blur: int = 0
    offset: int = -2


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
MASK = MaskConfig()
PIPELINE = PipelineConfig()
SAM = SamConfig()
