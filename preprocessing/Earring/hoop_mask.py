"""Front/rear split-mask generation for Hoop earrings (Phase 12D).

STATUS: placeholder, not a validated detector. Phase 12D was explicitly
scoped (see IMPLEMENTATION_PLAN.md, Phase 12D) to require a real algorithm
proposal validated against real hoop photography *before* implementation —
no such photography exists yet (2026-07-29 decision: proceed with the rest
of 12D's architecture now; design the actual detection algorithm once a
representative image set is available). This module exists so that
boundary, runner.py's hoop branch, the shadow/compositing path, and the
whole NDJSON/detected/UI plumbing can be built and exercised end-to-end
today, without pretending the pixel math below is tuned or correct.

generate_hoop_mask always returns detected=False — every hoop image is
therefore routed to manual review (the same low-confidence convention
shank_mask.py and ring_mask.py already use for their own "no reliable
signal" cases), since a fixed bbox-midpoint split carries no real per-image
signal. Replacing this module's internals with a real detector is the only
change Phase 12D's next iteration needs to make — runner.py's integration
point (the (mask, detected) contract) does not change.

Orientation (confirmed, Phase 12D architecture approval): the split is a
single VERTICAL boundary — one x-position, not a per-row-varying curve like
shank_mask.py's per-column cut. It separates the hoop's own bounding box
into a left portion and a right portion; front_is_left below fixes the
polarity (an arbitrary placeholder choice, since there is no photography yet
to confirm which side reads as "front" in this business's real hoop
photography). This same single-scalar, vertical-boundary shape is what the
Phase 12E manual editor lets an operator drag directly.

Manual mode (Phase 12E): build_mask_from_split_x is the shared rendering
step factored out of generate_hoop_mask specifically so Automatic
(vertical_split_x's estimate) and Manual (an operator-placed, persisted
config.hoopSplits value, denormalized to pixels by runner.py) produce
identically-styled masks — only where split_x comes from differs. A
manually-placed split has no "detected" concept of its own; runner.py
reports detected=True for it unconditionally (a human placed it — no
low-confidence badge), mirroring Ring & Bracelet's own Manual-mode
convention.

Mask edge: the same soft sigmoid transition shank_mask.py/ring_mask.py use
(~1.5% of the bbox's own extent), per explicit approval — proven visually
elsewhere, no reason to introduce a second edge style before real hoop
photography suggests one is needed.

Safety clamp: the split can never land closer to either bbox edge than
EDGE_SAFE_FRACTION, mirroring ring_mask.py's CROWN_SAFE_FRACTION guard — a
structural guarantee against a degenerate split that would erase almost the
entire hoop, independent of whatever produces the raw split estimate.
"""

from __future__ import annotations

import cv2
import numpy as np

ALPHA_THRESH = 12

# Neither side of the split may sit within this fraction of the bbox's own
# width from either edge — keeps a degenerate estimate from erasing nearly
# the whole hoop. Real detection logic (once written) is still bound by this
# clamp; it does not need to reimplement it.
EDGE_SAFE_FRACTION = 0.15

# Placeholder convention only — see module docstring. front (kept opaque in
# frontImage) is the side named True here; rear (mask, made transparent) is
# the other side.
FRONT_IS_LEFT = True


def _odd(value: float) -> int:
    n = max(1, int(round(value)))
    return n if n % 2 == 1 else n + 1


def vertical_split_x(alpha: np.ndarray) -> tuple[float, bool]:
    """Return (split_x, detected) — the x-coordinate of the front/rear
    boundary in image pixel space, and whether it should be trusted.

    Placeholder implementation: the bbox's own horizontal midpoint, clamped
    to stay EDGE_SAFE_FRACTION away from either edge. detected is always
    False (see module docstring) — this is a structural stand-in, not a
    measurement.
    """
    h, w = alpha.shape[:2]
    fg = alpha > ALPHA_THRESH
    ys, xs = np.where(fg)
    if len(xs) == 0:
        return w / 2.0, False

    bb_left, bb_right = int(xs.min()), int(xs.max())
    bb_w = bb_right - bb_left + 1

    split_x = (bb_left + bb_right) / 2.0
    lo = bb_left + EDGE_SAFE_FRACTION * bb_w
    hi = bb_right - EDGE_SAFE_FRACTION * bb_w
    split_x = float(np.clip(split_x, lo, hi))
    return split_x, False


def build_mask_from_split_x(alpha: np.ndarray, split_x: float) -> np.ndarray:
    """Return the soft rear-portion mask for a given absolute-pixel split_x —
    the shared rendering step behind both generate_hoop_mask (Automatic,
    split_x from vertical_split_x) and Manual mode (Phase 12E, split_x
    denormalized from an operator-placed config.hoopSplits value in
    runner.py). Both paths converge here so a manually-placed split renders
    with exactly the same soft edge and grown-silhouette treatment as an
    automatically-detected one — "matching the automatic detector's
    contract" per the approved 12E architecture, not a second mask style.

    alpha must already be a single-channel (H, W) uint8 array — callers own
    their own shape/dtype normalization (generate_hoop_mask's own
    validation, or runner.py's np.array(img)[:, :, 3]).
    """
    h, w = alpha.shape[:2]
    fg = alpha > ALPHA_THRESH
    if fg.sum() == 0:
        return np.zeros((h, w), dtype=np.uint8)

    ys, xs = np.where(fg)
    bb_h = int(ys.max() - ys.min() + 1)
    bb_w = int(xs.max() - xs.min() + 1)

    soft = max(1.5, bb_w * 0.015)
    xx = np.arange(w, dtype=np.float64)[None, :]
    left_factor = np.clip((split_x - xx) / soft + 0.5, 0.0, 1.0)
    rear_factor = (1.0 - left_factor) if FRONT_IS_LEFT else left_factor

    # Same soft-edge-on-a-slightly-grown-silhouette treatment as
    # shank_mask.py's generate_wrap_mask — the small dilation keeps the mask
    # from leaving a hairline of stale full-opacity alpha right at the
    # subject's own anti-aliased edge pixels.
    k = max(3, _odd(bb_h * 0.05))
    grown = cv2.dilate(
        (fg.astype(np.uint8) * 255),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)),
    )
    band = (grown > 0).astype(np.float64)
    return (rear_factor * band * 255.0).astype(np.uint8)


def generate_hoop_mask(alpha: np.ndarray) -> tuple[np.ndarray, bool]:
    """Return (mask, detected). ``mask`` is the soft alpha for the rear
    portion (to the right of the split when FRONT_IS_LEFT, else the left);
    ``detected`` is False for this placeholder implementation unconditionally
    (see module docstring) — route to manual review."""
    if alpha is None:
        return np.zeros((1, 1), dtype=np.uint8), False
    if alpha.ndim == 3:
        alpha = alpha[:, :, -1]
    alpha = alpha.astype(np.uint8)
    h, w = alpha.shape[:2]
    if h <= 1 or w <= 1:
        return np.zeros((h, w), dtype=np.uint8), False
    if (alpha > ALPHA_THRESH).sum() == 0:
        return np.zeros((h, w), dtype=np.uint8), False

    split_x, detected = vertical_split_x(alpha)
    mask = build_mask_from_split_x(alpha, split_x)
    return mask, detected
