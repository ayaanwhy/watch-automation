"""Shank/wrap occlusion mask generation for Ring & Bracelet assets.

Ported from the shankMask project's ``pipeline/wrap.py`` (Phase 10B
investigation). Only the mask-generation algorithm is reused here — it is
pure OpenCV/NumPy morphology with no ML model, no file I/O, and no network
dependency, so it lifts out as-is. Everything else about shankMask (its
FastAPI server, Docker setup, HTTP endpoints, storage layer, manifest
system, and live VTO/on-model compositing) is intentionally not reused —
WPA owns orchestration, batching, file I/O, and asset generation itself;
this module is a pure function library for one step of that pipeline.

Verified (Phase 10C extraction) against shankMask's own precomputed
reference output for a real bracelet sample — see the project's test
fixtures/manual verification notes for that comparison.

Generates a default "behind the wrist" wrap mask for a bracelet cutout: a
soft alpha mask in product-pixel space marking the rear/upper arc of the
band (the part the wrist passes in front of). The cut between the rear rim
and the front-facing arc is traced from the band's own hole topology, so
the mask hugs the real back rim instead of swallowing the whole band — this
keeps it correct for both tall bangles and flat tennis/chain bracelets. It
is a starting point for human review/refinement, not a final answer; when
the loop topology can't be found (``detected=False``), the caller should
route the image to manual review rather than trust the fallback split.

Proven domain: bracelets only. Ring shank topology (a band around a finger)
has not been verified to generalize to this same algorithm — treat any
ring usage as unproven until checked against real ring photos.
"""

from __future__ import annotations

import cv2
import numpy as np


def _odd(value: float) -> int:
    n = max(1, int(round(value)))
    return n if n % 2 == 1 else n + 1


def _column_runs(col: np.ndarray) -> list[tuple[int, int]] | None:
    ys = np.where(col > 0)[0]
    if not len(ys):
        return None
    runs = []
    start = prev = ys[0]
    for y in ys[1:]:
        if y > prev + 1:
            runs.append((int(start), int(prev)))
            start = y
        prev = y
    runs.append((int(start), int(prev)))
    return runs


def topology_cut_line(alpha: np.ndarray) -> tuple[np.ndarray, bool]:
    """Per-column y of the rear-rim cut, traced from the loop's hole topology.

    For each column of the link-joined band: when the loop's hole separates a
    top rim from the body below, the cut is the gap midpoint. Side columns where
    the rim and front arc merge into one tall run are trimmed to the measured
    front thickness; genuinely thin side curls are kept whole. The line is then
    interpolated across columns without a clean gap and smoothed.

    Kernel sizes scale to the band's own bounding box, never the full image, so
    a loosely-cropped photo with large margins does not inflate the close kernel
    and bridge the hole.
    """
    h, w = alpha.shape[:2]
    fg = (alpha > 12).astype(np.uint8) * 255
    ys0, xs0 = np.where(fg > 0)
    if len(xs0) == 0:
        return np.full(w, h * 0.35), False

    bb_left, bb_right = int(xs0.min()), int(xs0.max())
    bb_top, bb_bottom = int(ys0.min()), int(ys0.max())
    bb_w = bb_right - bb_left + 1
    bb_h = bb_bottom - bb_top + 1

    close_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (_odd(bb_w * 0.045), _odd(bb_h * 0.055))
    )
    joined = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, close_kernel, iterations=1)

    cut = np.full(w, np.nan, dtype=np.float64)
    min_gap = max(2.0, bb_h * 0.02)
    runs_by_col = [None] * w
    gap_cols = np.zeros(w, dtype=bool)
    below_heights = []
    for x in range(w):
        runs = _column_runs(joined[:, x])
        runs_by_col[x] = runs
        if not runs:
            continue
        for i in range(len(runs) - 1):
            top_run, below = runs[i], runs[i + 1]
            if below[0] - top_run[1] >= min_gap:
                cut[x] = (top_run[1] + below[0]) / 2.0
                gap_cols[x] = True
                below_heights.append(below[1] - below[0] + 1)
                break

    xs = np.arange(w)
    if gap_cols.sum() < bb_w * 0.1:
        # No detectable hole (e.g. a solid worn-view photo): low confidence. Fall
        # back to a cut just above the band's vertical centre (band-relative).
        return np.full(w, bb_top + bb_h * 0.35), False

    ft = float(np.median(below_heights)) if below_heights else bb_h * 0.18
    ft = float(np.clip(ft, bb_h * 0.06, bb_h * 0.40))
    for x in range(w):
        runs = runs_by_col[x]
        if gap_cols[x] or not runs:
            continue
        r_top, r_bottom = runs[0][0], runs[-1][1]
        run_h = r_bottom - r_top + 1
        if run_h <= ft * 1.4:
            cut[x] = r_top - 1.0            # thin: keep the whole side curl
        else:
            cut[x] = r_bottom - ft * 1.25   # tall merged run: trim back rim

    valid = ~np.isnan(cut)
    cut = np.interp(xs, xs[valid], cut[valid])
    k = _odd(bb_w * 0.06)
    kernel = cv2.getGaussianKernel(k, max(1.0, bb_w * 0.015)).flatten()
    kernel /= kernel.sum()
    cut = np.convolve(np.pad(cut, k // 2, mode="edge"), kernel, mode="valid")
    return cut, True


def generate_wrap_mask(alpha: np.ndarray, split_y: float = 0.5) -> tuple[np.ndarray, bool]:
    """Return (mask, detected). ``mask`` is the soft alpha for the rear rim that
    sits above the traced cut line; ``detected`` is False when the loop topology
    was not found (low confidence — route to manual review)."""
    if alpha is None:
        return np.zeros((1, 1), dtype=np.uint8), False
    if alpha.ndim == 3:
        alpha = alpha[:, :, -1]
    alpha = alpha.astype(np.uint8)
    h, w = alpha.shape[:2]
    if h <= 1 or w <= 1:
        return np.zeros((h, w), dtype=np.uint8), False
    fg = alpha > 12
    if fg.sum() == 0:
        return np.zeros((h, w), dtype=np.uint8), False

    ys, xs = np.where(fg)
    bb_h = int(ys.max() - ys.min() + 1)

    cut, detected = topology_cut_line(alpha)
    # Cover the full rear rim including its lower edge near the cut.
    cut = cut + bb_h * 0.04
    yy = np.arange(h, dtype=np.float64)[:, None]
    soft = max(1.5, h * 0.015)
    above = np.clip((cut[None, :] - yy) / soft + 0.5, 0.0, 1.0)  # 1 above the cut
    # Gate by a slightly grown binary of the band (not the soft product alpha) so
    # anti-aliased edge pixels are fully covered and leave no residual outline,
    # while the mask still hugs the band rather than the empty hole above it.
    k = max(3, _odd(bb_h * 0.05))
    grown = cv2.dilate((fg.astype(np.uint8) * 255),
                       cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    band = (grown > 0).astype(np.float64)
    mask = ((1.0 - above) * band * 255).astype(np.uint8)
    return mask, detected
