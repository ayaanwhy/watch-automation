"""Shared drop-shadow generation engine (Phase 11.5C; canvas compositing
added in a Phase 11.5C follow-up; promoted from RingBracelet/ to this shared
location, generalized with per-profile capability flags, and given a second
consumer — Earring — in Phase 12C).

Ported from packages/processing/src/processing/shadowEngine.ts (the Watch
pipeline's existing TypeScript shadow engine) — see IMPLEMENTATION_PLAN.md,
"Ring & Bracelet Shadow Generation — Resolved Integration Approach" for the
full architecture decision. This is a straight algorithmic port (threshold →
density dilation → optional spread dilation → Gaussian blur → offset →
horizontal falloff mask), not a reinterpretation: every consumer uses the
same masked-shadow technique as Watch, with its own tuning
(RING_BRACELET_SHADOW / EARRING_SHADOW) kept structurally independent of
Watch's defaultShadowSettings and of each other, so tuning one profile never
affects another.

Canvas approach (follow-up refinement): like Watch's exportEngine.ts, the
shadow is not generated directly on the tightly-cropped working image — it
is generated on a padded transparent canvas the image is centered on, then
the result is trimmed back to its actual content bounds before export. This
gives the shadow room to extend beyond the working image's own crop (blur
spread, vertical offset) without being clipped by the image's edges, and
makes shadow behavior independent of how tightly upstream preprocessing
happened to crop that particular SKU. Unlike Watch — whose 2000x2000 canvas
is also its fixed final output width — neither Ring & Bracelet nor Earring
has a fixed-width output contract, so the canvas here is a temporary working
surface only; the final export is auto-trimmed to its own content bounds on
all four sides (Watch's trimTransparentTopBottom trims top/bottom only,
since its canvas width *is* the output width by design).

The horizontal falloff breakpoints (5%/20%/80%/95%, generalizing
shadowEngine.ts's fixed 100/400/1600/1900px) are computed relative to the
*working image's own width*, not the padded canvas width — otherwise the
same image would get a different-looking falloff depending on how much
padding happened to be needed, which is exactly the crop-dependence this
refinement is meant to eliminate.

Per-profile capability flags (Phase 12C) — every one defaults to whatever
value reproduces RING_BRACELET_SHADOW's exact pre-12C behavior, so that
profile needs no changes and the promotion is behavior-preserving by
construction, not by careful test-writing:
  horizontal_falloff (default True)  — see _apply_horizontal_mask. Earring
    sets this False (Resolved Decision 5): the falloff is a Watch/Ring &
    Bracelet-specific visual language choice, not applied to Earring.
  casting_region (default None)      — an optional top-fraction source-alpha
    clip, e.g. 0.10 restricts shadow casting to the subject's own top 10%
    (Drop's "upper anchor region"). Relative to the *subject's* position via
    subject_top/subject_height, the same way horizontal falloff is already
    relative to subject_left/subject_width — otherwise the anchor region
    would silently drift depending on how much canvas padding a given image
    happened to need.
  canvas_base (default 2000)         — Earring's working canvas basis is
    1000 (Resolved Decision 2); Ring & Bracelet's stays 2000.

(A trim_output flag was added alongside these in 12C, anticipating Hoop's
alignment contract — Hoop's actual 12D/12E implementation ended up bypassing
this whole padded-canvas approach instead, calling create_drop_shadow()
directly on an unpadded, already-compare-sized canvas, so the flag was never
exercised by any real caller. Removed in the Phase 12 final-consistency pass;
see IMPLEMENTATION_PLAN.md's Phase 12 Debt Register.)
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

# Same underlying algorithm/tuning shape as Watch's defaultShadowSettings
# (packages/processing/src/processing/shadowEngine.ts) — color, opacity, and
# density intentionally match Watch's values (density is an explicit design
# decision, not a placeholder; see IMPLEMENTATION_PLAN.md). Only the
# distance (y_offset) and blur (blur_radius) are Ring & Bracelet-specific,
# per the approved Photoshop-style layer values.
RING_BRACELET_SHADOW = {
    "x_offset": 0,
    "y_offset": 50,
    "blur_radius": 40,
    "spread": 0,
    "density": 1.75,
    "opacity": 0.3,
    "color": "#2e170a",
}

# Phase 12 Resolved Decision 5. Photoshop layer style -> engine parameter:
#   Color #2e170a          -> color            (same as Watch/Ring & Bracelet)
#   Opacity 40%             -> opacity 0.4
#   Angle 90 deg, Dist 20px -> x_offset 0, y_offset 20 (same convention as
#                              Ring & Bracelet: 90 deg = straight down)
#   Size 24px               -> blur_radius 24
#   Spread 30%               -> spread 7px — SEE MAPPING NOTE BELOW
#   (unspecified)            -> density 1.75 (same as Watch/Ring & Bracelet)
#   (unspecified)            -> horizontal_falloff False, canvas_base 1000
#
# Spread mapping (approved before implementation, Phase 12C): this engine's
# own `spread` field has always been a raw pixel dilation radius
# (_dilate(mask, round(settings["spread"]))), never a percentage — it was
# never previously exercised with a nonzero value, since Ring & Bracelet's
# Spread is 0% (where the unit ambiguity doesn't matter: 0 either way).
# EARRING_SHADOW's Spread: 30% is the first nonzero case, so an explicit
# mapping was required. Approved convention, to be followed by any future
# profile: spread_px = round(size_px * spread_percent), i.e. Spread is a
# fraction of Size (this profile: round(24 * 0.30) = 7).
#
# casting_region is deliberately NOT part of this profile — it varies by
# earring type (Stud: none; Drop/Hoop: 0.10), so preprocessing/Earring/runner.py
# merges it in per-image based on the resolved type, rather than baking one
# fixed value into the shared profile.
EARRING_SHADOW = {
    "x_offset": 0,
    "y_offset": 20,
    "blur_radius": 24,
    "spread": 7,
    "density": 1.75,
    "opacity": 0.4,
    "color": "#2e170a",
    "horizontal_falloff": False,
    "canvas_base": 1000,
}

# Watch's canvas (2000x2000) is also its fixed output width, so it never
# needs extra padding beyond that. Ring & Bracelet has no such contract, so
# on top of matching Watch's 2000px baseline, a fixed margin is added on
# every side specifically to give the shadow room — comfortably larger than
# RING_BRACELET_SHADOW's own reach (blur_radius 40's visible tail plus a
# 50px offset is on the order of 100-150px) with headroom for future
# retuning of that one profile without this margin needing to change too.
# canvas_base itself became a per-profile settings key in Phase 12C (see
# composite_with_shadow); this constant remains the *default* base
# (Ring & Bracelet's own canvas_base) and CANVAS_MARGIN stays a shared,
# unparameterized constant — the plan calls for canvas_base to vary per
# profile, not the margin.
BASE_CANVAS_SIZE = 2000
CANVAS_MARGIN = 200


def _parse_hex_color(value: str) -> tuple[int, int, int]:
    v = value.strip().lstrip("#")
    if len(v) != 6:
        raise ValueError("Shadow color must be a 6-digit hex color")
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def _threshold_alpha(alpha: np.ndarray) -> np.ndarray:
    return np.where(alpha > 0, 255, 0).astype(np.uint8)


def _dilate(alpha: np.ndarray, radius: int) -> np.ndarray:
    """Max-filter dilation — matches shadowEngine.ts's dilateAlpha (a
    separable horizontal-then-vertical max filter over a square window)."""
    if radius <= 0:
        return alpha
    size = 2 * radius + 1
    return np.array(Image.fromarray(alpha, mode="L").filter(ImageFilter.MaxFilter(size)))


def _apply_density(alpha: np.ndarray, density: float) -> np.ndarray:
    multiplier = max(0.0, density)
    if multiplier <= 1:
        return alpha
    radius = round((multiplier - 1) * 4)
    return _dilate(alpha, radius)


def _blur(alpha: np.ndarray, radius: float) -> np.ndarray:
    if radius <= 0:
        return alpha
    return np.array(Image.fromarray(alpha, mode="L").filter(ImageFilter.GaussianBlur(radius)))


def _offset(alpha: np.ndarray, x_offset: float, y_offset: float) -> np.ndarray:
    """Translates the mask by (x_offset, y_offset); pixels shifted outside
    the frame are dropped (no wraparound) — matches shadowEngine.ts's
    offsetAlpha exactly."""
    x_off = round(x_offset)
    y_off = round(y_offset)
    if x_off == 0 and y_off == 0:
        return alpha
    height, width = alpha.shape
    output = np.zeros_like(alpha)
    src_x0, src_y0 = max(0, -x_off), max(0, -y_off)
    src_x1, src_y1 = min(width, width - x_off), min(height, height - y_off)
    if src_x0 >= src_x1 or src_y0 >= src_y1:
        return output
    dst_x0, dst_y0 = src_x0 + x_off, src_y0 + y_off
    dst_x1, dst_y1 = src_x1 + x_off, src_y1 + y_off
    output[dst_y0:dst_y1, dst_x0:dst_x1] = alpha[src_y0:src_y1, src_x0:src_x1]
    return output


def _smoothstep(value: np.ndarray) -> np.ndarray:
    c = np.clip(value, 0.0, 1.0)
    return c * c * (3 - 2 * c)


def _horizontal_falloff(canvas_width: int, subject_left: int, subject_width: int) -> np.ndarray:
    """Proportional generalization of shadowEngine.ts's maskAlphaAtX — see
    module docstring. Breakpoints are relative to the *subject's* own width
    and position (subject_left..subject_left+subject_width), not the full
    canvas, so padding for shadow room never changes the falloff shape.
    With subject_left=0 and subject_width=2000 this reproduces the
    original's exact 100/400/1600/1900px breakpoints."""
    x = np.arange(canvas_width, dtype=np.float64) - subject_left
    b0, b1, b2, b3 = 0.05 * subject_width, 0.20 * subject_width, 0.80 * subject_width, 0.95 * subject_width
    result = np.zeros(canvas_width, dtype=np.float64)

    fade_in = (x >= b0) & (x < b1)
    if b1 > b0:
        result[fade_in] = _smoothstep((x[fade_in] - b0) / (b1 - b0))

    result[(x >= b1) & (x <= b2)] = 1.0

    fade_out = (x > b2) & (x <= b3)
    if b3 > b2:
        result[fade_out] = _smoothstep((b3 - x[fade_out]) / (b3 - b2))

    return result


def _apply_horizontal_mask(
    alpha: np.ndarray, opacity: float, subject_left: int, subject_width: int, use_falloff: bool = True
) -> np.ndarray:
    row_mask = (
        _horizontal_falloff(alpha.shape[1], subject_left, subject_width)
        if use_falloff
        else np.ones(alpha.shape[1], dtype=np.float64)
    )
    result = alpha.astype(np.float64) * (opacity * row_mask)[np.newaxis, :]
    return np.clip(np.round(result), 0, 255).astype(np.uint8)


def _clip_casting_region(alpha: np.ndarray, subject_top: int, subject_height: int, fraction: float) -> np.ndarray:
    """Zeroes source alpha outside the top `fraction` of the *subject's* own
    height (e.g. 0.10 for Drop/Hoop's upper-anchor-only casting region) —
    restricts WHERE the shadow is cast from; the downstream density/spread/
    blur/offset/falloff steps still operate on the full (now-clipped) mask
    exactly as before. Relative to subject_top the same way horizontal
    falloff is relative to subject_left — see module docstring."""
    clipped = alpha.copy()
    if subject_top > 0:
        clipped[:subject_top, :] = 0
    cutoff = subject_top + max(0, round(subject_height * fraction))
    if cutoff < clipped.shape[0]:
        clipped[cutoff:, :] = 0
    return clipped


def create_drop_shadow(
    image: Image.Image,
    settings: dict = RING_BRACELET_SHADOW,
    subject_left: int = 0,
    subject_width: int | None = None,
    subject_top: int = 0,
    subject_height: int | None = None,
) -> Image.Image:
    """Given an RGBA image, returns a new RGBA image of the same size
    containing only the shadow layer (solid color + computed alpha) — the
    caller composites it behind the original, mirroring shadowEngine.ts's
    createDropShadow/exportEngine.ts split.

    subject_left/subject_width scope the horizontal falloff to the actual
    subject rather than the full (possibly padded) image — see
    _horizontal_falloff. subject_top/subject_height (Phase 12C) do the same
    for casting_region. Both default to the whole image, i.e. calling this
    directly on an unpadded image reproduces the original per-image
    behavior exactly (this is what the TS-engine equivalence check in
    IMPLEMENTATION_PLAN.md validated)."""
    img = image.convert("RGBA")
    alpha = np.array(img)[:, :, 3]
    if subject_width is None:
        subject_width = alpha.shape[1] - subject_left
    if subject_height is None:
        subject_height = alpha.shape[0] - subject_top

    casting_region = settings.get("casting_region")
    if casting_region is not None:
        alpha = _clip_casting_region(alpha, subject_top, subject_height, casting_region)

    color = _parse_hex_color(settings["color"])
    mask = _threshold_alpha(alpha)
    mask = _apply_density(mask, settings["density"])
    if settings.get("spread", 0) > 0:
        mask = _dilate(mask, round(settings["spread"]))
    mask = _blur(mask, settings["blur_radius"])
    mask = _offset(mask, settings["x_offset"], settings["y_offset"])
    final_alpha = _apply_horizontal_mask(
        mask,
        max(0.0, min(1.0, settings["opacity"])),
        subject_left,
        subject_width,
        use_falloff=settings.get("horizontal_falloff", True),
    )

    shadow_arr = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    shadow_arr[:, :, 0] = color[0]
    shadow_arr[:, :, 1] = color[1]
    shadow_arr[:, :, 2] = color[2]
    shadow_arr[:, :, 3] = final_alpha
    return Image.fromarray(shadow_arr, mode="RGBA")


def _trim_to_content(image: Image.Image) -> Image.Image:
    """Auto-crops to the non-transparent bounding box on all four sides.
    Generalizes Watch's trimTransparentTopBottom (top/bottom only, since
    Watch's canvas width already equals its output width) — Ring & Bracelet
    has no fixed-width contract, so trimming needs to reclaim the padding on
    every side, not just top/bottom."""
    alpha = np.array(image)[:, :, 3]
    rows = np.where(alpha.any(axis=1))[0]
    cols = np.where(alpha.any(axis=0))[0]
    if rows.size == 0 or cols.size == 0:
        return image
    top, bottom = int(rows[0]), int(rows[-1])
    left, right = int(cols[0]), int(cols[-1])
    return image.crop((left, top, right + 1, bottom + 1))


def composite_with_shadow(image: Image.Image, settings: dict = RING_BRACELET_SHADOW) -> Image.Image:
    """Places `image` centered on a padded transparent canvas, generates the
    shadow on that canvas (so blur/offset have room regardless of how
    tightly `image` was cropped), composites the subject back over the
    shadow, then trims to content bounds — the exported image grows just
    enough to include the full shadow; nothing about the subject itself
    changes. Same output contract as before the original (Phase 11.5C)
    canvas refinement: a single RGBA PNG, just not clipped to the
    pre-shadow crop.

    Always trims. Hoop's alignment contract (Phase 12 Resolved Decision 4),
    which needs an untrimmed, unpadded, exact-size canvas, is met by calling
    create_drop_shadow() directly instead of this wrapper — see
    preprocessing/Earring/runner.py's _process_hoop."""
    img = image.convert("RGBA")
    canvas_base = settings.get("canvas_base", BASE_CANVAS_SIZE)
    canvas_size = max(canvas_base, img.width + CANVAS_MARGIN, img.height + CANVAS_MARGIN)
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    paste_x = (canvas_size - img.width) // 2
    paste_y = (canvas_size - img.height) // 2
    canvas.paste(img, (paste_x, paste_y), img)

    shadow = create_drop_shadow(
        canvas, settings,
        subject_left=paste_x, subject_width=img.width,
        subject_top=paste_y, subject_height=img.height,
    )
    composited = Image.alpha_composite(shadow, canvas)
    return _trim_to_content(composited)
