from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


def save_preview(
    original_path: str | Path,
    birefnet_image: Image.Image,
    masks: list[dict],
    output_path: str | Path,
) -> str:
    original = Image.open(original_path).convert("RGB")
    result = Image.alpha_composite(
        Image.new("RGBA", birefnet_image.size, (255, 255, 255, 255)),
        birefnet_image.convert("RGBA"),
    ).convert("RGB")
    mask_preview = Image.new("RGB", result.size, (255, 255, 255))

    colors = [(255, 0, 0), (0, 180, 80), (0, 100, 255), (255, 170, 0), (160, 0, 255)]
    for index, mask in enumerate(masks):
        mask_image = Image.open(mask["path"]).convert("L").resize(result.size)
        color = Image.new("RGB", result.size, colors[index % len(colors)])
        mask_preview = Image.composite(color, mask_preview, mask_image)

    width = max(original.width, result.width, mask_preview.width)
    total_height = original.height + result.height + mask_preview.height
    preview = Image.new("RGB", (width, total_height), (245, 245, 245))
    y = 0
    for title, image in (("Original", original), ("BiRefNet result", result), ("SAM masks", mask_preview)):
        preview.paste(image, (0, y))
        draw = ImageDraw.Draw(preview)
        draw.rectangle((0, y, min(width, 320), y + 38), fill=(0, 0, 0))
        draw.text((12, y + 10), title, fill=(255, 255, 255))
        y += image.height

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    preview.save(output)
    return str(output)
