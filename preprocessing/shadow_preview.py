#!/usr/bin/env python3
"""
shadow_preview.py — one-shot shadow-profile preview render (Phase 13H).

Settings' Shadow Profiles editor needs a fast, real Python-backed preview of
a single edited (not-yet-saved) profile. This is a standalone entry point,
not part of any production runner, so editing shadow settings in Settings
can never touch the actual production path (RingBracelet/runner.py,
Earring/runner.py both still resolve their own settings independently — see
_load_shadow_settings in each). It reuses shadow.py's own
composite_with_shadow() unmodified — the same function every production
runner calls — so what the user sees in the preview is the exact same
compositing algorithm, just fed a synthetic subject instead of a real
product photo (no real product photography ships with this repo).

Usage:
    python shadow_preview.py --settings-file <path> --output <path>

--settings-file is a JSON object matching one ShadowProfileValues shape
(x_offset, y_offset, blur_radius, spread, density, opacity, color,
horizontal_falloff, canvas_base) — written fresh by the Electron main
process for every debounced preview request.

Exits 0 with the PNG written to --output on success, non-zero with a
message on stderr on failure. No NDJSON protocol, no runner_base.py
involvement — this is a single synchronous render, not a batch job.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from shadow import composite_with_shadow  # noqa: E402


def _build_sample_silhouette(size: int = 360) -> Image.Image:
    """A generic ring-shaped silhouette — not a real product photo, just a
    subject with enough shape variation (outer curve, inner cutout) to make
    offset/blur/spread/density/falloff differences visible in the preview.
    Rendered at 4x and downsampled for anti-aliased edges, since shadow.py's
    alpha thresholding (_threshold_alpha) is sensitive to jagged input
    edges.
    """
    scale = 4
    big = size * scale
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    outer_margin = big * 0.12
    inner_margin = big * 0.32
    draw.ellipse([outer_margin, outer_margin, big - outer_margin, big - outer_margin], fill=(200, 170, 90, 255))
    draw.ellipse([inner_margin, inner_margin, big - inner_margin, big - inner_margin], fill=(0, 0, 0, 0))
    return canvas.resize((size, size), Image.LANCZOS)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="shadow_preview",
        description="One-shot shadow-profile preview render (Settings -> Shadow Profiles, Phase 13H).",
    )
    p.add_argument("--settings-file", required=True, help="Path to a JSON ShadowProfileValues object.")
    p.add_argument("--output", required=True, help="Path to write the rendered PNG.")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        with open(args.settings_file, "r", encoding="utf-8") as f:
            settings = json.load(f)
        if not isinstance(settings, dict):
            raise ValueError(f"Settings file must be a JSON object, got {type(settings).__name__}")
    except (OSError, ValueError) as exc:
        print(f"Failed to read settings file: {exc}", file=sys.stderr)
        return 1

    subject = _build_sample_silhouette()
    rendered = composite_with_shadow(subject, settings)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    rendered.save(output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
