from pathlib import Path

from config import EDGE, MASK, PIPELINE, UPSCALE
from services.plugin_loader import process_with_plugin
from services.preview import save_preview
from services.sam_segmenter import segment_image
from stage0.background_remover import BackgroundRemover
from services.upscaler import upscale_image


def _ask_scale_factor() -> int:
    prompt = f"Enter upscale amount (1, 2, or 4) [{UPSCALE.scale_factor}]: "
    raw = input(prompt).strip()
    if not raw:
        return UPSCALE.scale_factor
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("Upscale amount must be 1, 2, or 4.") from exc
    if value not in {1, 2, 4}:
        raise ValueError("Upscale amount must be 1, 2, or 4.")
    return value


def main():
    base = Path(__file__).resolve().parent
    input_dir = Path(PIPELINE.input_dir).expanduser()
    output_dir = Path(PIPELINE.output_dir).expanduser()
    temp_dir = Path(PIPELINE.temp_dir).expanduser()
    scale_factor = _ask_scale_factor()
    if not input_dir.is_absolute():
        input_dir = base / input_dir
    if not output_dir.is_absolute():
        output_dir = base / output_dir
    if not temp_dir.is_absolute():
        temp_dir = base / temp_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    temp_dir.mkdir(parents=True, exist_ok=True)
    png_dir = output_dir / "png"
    masks_dir = output_dir / "masks"
    preview_dir = output_dir / "preview"
    png_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)
    preview_dir.mkdir(parents=True, exist_ok=True)

    images = sorted(
        p for p in input_dir.iterdir()
        if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    if not images:
        raise FileNotFoundError(f"No supported images found in {input_dir}")

    remover = BackgroundRemover(model_root=base / "stage0" / "BiRefNet")
    for input_path in images:
        temp_upscaled_path = temp_dir / f"{input_path.stem}_upscaled.png"
        output_path = output_dir / f"{input_path.stem}{PIPELINE.output_suffix}"
        try:
            print("Loading image...")
            upscaled_path = upscale_image(
                str(input_path),
                str(temp_upscaled_path),
                scale_factor=scale_factor,
            )
            print("Running background removal...")
            rgba = remover.remove_background(
                upscaled_path,
                mask_blur=MASK.blur,
                mask_offset=MASK.offset,
                invert_output=False,
                refine_foreground=PIPELINE.refine_foreground,
                edge_mode=EDGE.mode,
                edge_strength=EDGE.strength,
                background=PIPELINE.background,
                background_color=PIPELINE.background_color,
                artifact_name=input_path.stem,
            )
            print("Background removal complete.")
            masks = segment_image(rgba, artifact_name=input_path.stem, output_dir=masks_dir)
            plugin_result = process_with_plugin(rgba, masks, object_type=PIPELINE.object_type)
            print(f"Plugin complete: {plugin_result.get('plugin', PIPELINE.object_type)}")
            final_rgba = plugin_result.get("processed_image", rgba)
            preview_path = preview_dir / f"{input_path.stem}_preview.png"
            save_preview(input_path, final_rgba, masks, preview_path)
            print("Saving output...")
            final_rgba.save(output_path, dpi=(PIPELINE.output_ppi, PIPELINE.output_ppi))
            final_rgba.save(png_dir / f"{input_path.stem}{PIPELINE.output_suffix}", dpi=(PIPELINE.output_ppi, PIPELINE.output_ppi))
            print("Done.")
            print(output_path)
        finally:
            if temp_upscaled_path.exists():
                temp_upscaled_path.unlink()


if __name__ == "__main__":
    main()
