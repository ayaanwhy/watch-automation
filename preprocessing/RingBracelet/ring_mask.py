"""Rear-shank occlusion mask generation for Ring assets (Phase 10E).

STATUS: experimental, currently unused. runner.py's --product dispatch does
not call generate_ring_mask() right now — both "ring" and "bracelet" run
shank_mask.generate_wrap_mask() (see the rollback note in runner.py's module
docstring and in _process_one). This is a temporary rollback of behavior
pending broader validation, not a judgment that the algorithm below is
wrong; it passed its available real-sample checks (see Phase 10E completion
report) but was only checked against two production ring photos. Re-enable
by changing runner.py's ring branch back to generate_ring_mask(alpha) — the
function below does not need to change to do that.

Orientation invariant: rings are photographed crown-up — the head/setting
sits at the top of the frame, the shank (the plain band that wraps the
finger) sits at the bottom. The occluded region for VTO purposes is always
the rear of the shank, i.e. a strip near the bottom of the band's own
silhouette. This is a different physical model from shank_mask.py's bracelet
algorithm, which locates the rear arc via the band's loop-hole topology —
that approach breaks down here because a ring's crown often contains its own
small gaps (between prong-set stones, between shoulders and centre stone)
that look exactly like the loop-hole gap the bracelet algorithm searches
for, causing it to mask the crown itself instead of the shank.

Boundary-offset model: instead of tracing a hole, this module walks each
column's own foreground silhouette from the bottom up and estimates the
local band thickness (via a distance-transform sample restricted to the
lower half of the frame), then places the cut one thickness-width above each
column's bottom edge. A genuine hole in the shank (the finger opening, or a
stacking gap) refines that estimate directly where it's visible, but the
offset — not the hole — is the primary signal; a ring with no visible hole
at all (an overlapping/worn-view crown, a soldered eternity band) still gets
a plausible cut. The bottom-boundary trace never considers geometry above
the crown-safe line, so unlike the bracelet algorithm, gaps inside the crown
cannot seed a cut — a structural guarantee, not a tuning outcome.

detected here means measurement coherence, not "was a hole found": it's
True when the thickness estimate didn't rail against its clamp bounds and
the crown-safe clamp didn't have to override most of the traced line. A
clean ring with no hole can still be detected=True; a ring whose silhouette
gave an implausible or heavily-clamped estimate is detected=False regardless
of whether a hole was present.
"""

from __future__ import annotations

import cv2
import numpy as np

# ── Tunable constants (bbox-relative; see spec for rationale per constant) ──

ALPHA_THRESH = 12
MIN_GAP_FLOOR_PX = 2.0
MIN_GAP_FRACTION = 0.02

# The crown invariant: nothing at or above this fraction of the band's own
# bounding-box height can seed or keep a cut. Single most likely tuning
# target if a ring class's crown genuinely extends past the frame's midline.
CROWN_SAFE_FRACTION = 0.50

# Central slice of the bbox width sampled for the thickness estimate —
# narrower than the full width so side-shank merges (where the band curves
# toward the viewer at the edges of the frame) don't skew it.
THICKNESS_X_SPAN = 0.60

T_MIN = 0.06
T_MAX = 0.35
T_FALLBACK = 0.15

# A "bottom run" wider than this multiple of the thickness estimate is
# almost certainly two side-shanks merged by the closing kernel, not a
# genuine shank cross-section — reject it as a refinement source.
REFINE_MAX_RATIO = 2.0
REFINE_MIN_COLS_FRACTION = 0.05

# Used only when zero columns survive the bottom-boundary trace (step 3) —
# must stay above CROWN_SAFE_FRACTION or the fallback would itself violate
# the crown invariant it exists to protect.
FALLBACK_CUT_FRACTION = 0.65

CLAMP_OVERRIDE_MAX_FRACTION = 0.5


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


def _estimate_band_thickness(
    joined: np.ndarray, bbox: tuple[int, int, int, int], safe_y: float
) -> tuple[float, bool]:
    """Estimate the shank's local thickness below the crown-safe line.

    Samples the distance transform of ``joined`` (each foreground pixel's
    distance to the nearest edge) across the central THICKNESS_X_SPAN of the
    bbox width, restricted to rows below ``safe_y`` so crown pixels never
    contribute. The transform peaks at roughly half the local band thickness
    at a column's centre, so thickness is recovered as 2x the *per-column
    maxima's* median. Pooling raw pixel values directly would median toward
    a quarter of the true thickness instead, since most pixels in a band sit
    off its centre line, not at the peak.

    Returns (t, reliable). ``reliable`` is False when the estimate railed
    against T_MIN/T_MAX or no column had any sampling data — both mean this
    number should not be trusted as a confidence signal upstream.
    """
    bb_left, bb_top, bb_right, bb_bottom = bbox
    bb_h = bb_bottom - bb_top + 1
    bb_w = bb_right - bb_left + 1

    dt = cv2.distanceTransform(joined, cv2.DIST_L2, 3)

    span = max(1, int(round(bb_w * THICKNESS_X_SPAN)))
    x_lo = max(0, bb_left + (bb_w - span) // 2)
    x_hi = min(joined.shape[1], x_lo + span)

    row_idx = np.arange(joined.shape[0])
    col_maxima: list[float] = []
    for x in range(x_lo, x_hi):
        below = (joined[:, x] > 0) & (row_idx > safe_y)
        if not below.any():
            continue
        col_maxima.append(float(dt[below, x].max()))

    lo, hi = T_MIN * bb_h, T_MAX * bb_h
    if not col_maxima:
        return float(np.clip(T_FALLBACK * bb_h, lo, hi)), False

    t = 2.0 * float(np.median(col_maxima))
    reliable = lo < t < hi
    return float(np.clip(t, lo, hi)), reliable


def rear_shank_cut_line(alpha: np.ndarray) -> tuple[np.ndarray, bool]:
    """Per-column y of the rear-shank cut, placed by thickness offset.

    Traces each column's own bottom foreground edge (ignoring anything at or
    above the crown-safe line), estimates local band thickness below that
    line, and places the cut one thickness above each traced column's bottom
    edge. A genuine hole directly above a plausible shank cross-section
    overrides that estimate for its own column and contributes to refining
    the thickness estimate for the rest. The crown-safe clamp is applied
    last, after refinement, so no column's cut can ever sit above the safe
    line regardless of what fed it.
    """
    h, w = alpha.shape[:2]
    fg = (alpha > ALPHA_THRESH).astype(np.uint8) * 255
    ys0, xs0 = np.where(fg > 0)
    if len(xs0) == 0:
        return np.full(w, h * FALLBACK_CUT_FRACTION), False

    bb_left, bb_right = int(xs0.min()), int(xs0.max())
    bb_top, bb_bottom = int(ys0.min()), int(ys0.max())
    bb_w = bb_right - bb_left + 1
    bb_h = bb_bottom - bb_top + 1

    close_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (_odd(bb_w * 0.045), _odd(bb_h * 0.055))
    )
    joined = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, close_kernel, iterations=1)

    safe_y = bb_top + CROWN_SAFE_FRACTION * bb_h

    # Bottom-boundary trace. A column whose foreground ends at or above the
    # safe line is a crown overhang with no visible shank beneath it in this
    # column — it must not seed a cut of its own; it gets interpolated later.
    bottom_y = np.full(w, np.nan, dtype=np.float64)
    traced = np.zeros(w, dtype=bool)
    for x in range(bb_left, bb_right + 1):
        ys = np.where(joined[:, x] > 0)[0]
        if len(ys) == 0:
            continue
        by = float(ys[-1])
        if by > safe_y:
            bottom_y[x] = by
            traced[x] = True

    if not traced.any():
        return np.full(w, bb_top + FALLBACK_CUT_FRACTION * bb_h), False

    t, reliable = _estimate_band_thickness(joined, (bb_left, bb_top, bb_right, bb_bottom), safe_y)

    cut = np.full(w, np.nan, dtype=np.float64)
    cut[traced] = bottom_y[traced] - t

    # Hole refinement: examine the gap directly above the bottommost run
    # (not the first gap from the top — that's the bracelet algorithm's
    # mistake, and reusing that shape here would reintroduce the crown bug).
    # Single pass: collect qualifying columns first, then decide whether
    # there's enough evidence to recompute t for the non-qualifying rest.
    min_gap = max(MIN_GAP_FLOOR_PX, bb_h * MIN_GAP_FRACTION)
    pending_override: dict[int, float] = {}
    refine_heights: list[float] = []
    for x in np.where(traced)[0]:
        runs = _column_runs(joined[:, x])
        if not runs or len(runs) < 2:
            continue
        prev_run, bottom_run = runs[-2], runs[-1]
        if bottom_run[0] - prev_run[1] < min_gap:
            continue
        run_h = bottom_run[1] - bottom_run[0] + 1
        if run_h > REFINE_MAX_RATIO * t:
            continue
        pending_override[int(x)] = bottom_run[0] - 1.0
        refine_heights.append(float(run_h))

    if len(pending_override) >= REFINE_MIN_COLS_FRACTION * bb_w:
        t = float(np.median([t] + refine_heights))
        lo, hi = T_MIN * bb_h, T_MAX * bb_h
        reliable = lo < t < hi
        t = float(np.clip(t, lo, hi))
        for x in np.where(traced)[0]:
            if x in pending_override:
                continue
            cut[x] = bottom_y[x] - t

    for x, value in pending_override.items():
        cut[x] = value

    # Crown clamp — applied after refinement, so a spurious high gap can
    # never bypass the invariant that nothing above the safe line is cut.
    pre_clamp = cut.copy()
    cut = np.maximum(cut, safe_y)
    clamped = int(np.sum(pre_clamp[traced] < safe_y))
    clamp_fraction = clamped / int(traced.sum())

    xs = np.arange(w)
    valid = ~np.isnan(cut)
    cut = np.interp(xs, xs[valid], cut[valid])
    k = _odd(bb_w * 0.06)
    kernel = cv2.getGaussianKernel(k, max(1.0, bb_w * 0.015)).flatten()
    kernel /= kernel.sum()
    cut = np.convolve(np.pad(cut, k // 2, mode="edge"), kernel, mode="valid")

    detected = reliable and clamp_fraction < CLAMP_OVERRIDE_MAX_FRACTION
    return cut, detected


def generate_ring_mask(alpha: np.ndarray) -> tuple[np.ndarray, bool]:
    """Return (mask, detected). ``mask`` is the soft alpha for the rear-shank
    strip near the bottom of the band's own silhouette; ``detected`` is False
    when the thickness estimate or crown clamp could not settle confidently
    (see rear_shank_cut_line) — low confidence, route to manual review."""
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

    cut, detected = rear_shank_cut_line(alpha)
    yy = np.arange(h, dtype=np.float64)[:, None]
    soft = max(1.5, h * 0.015)
    above = np.clip((cut[None, :] - yy) / soft + 0.5, 0.0, 1.0)
    # Same WPA orientation convention as shank_mask.py: front-facing portion
    # is above the cut, rear/shank is below it, so the mask (occluded region)
    # is the inverse of "above".
    k = max(3, _odd(bb_h * 0.05))
    grown = cv2.dilate((fg.astype(np.uint8) * 255),
                       cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    band = (grown > 0).astype(np.float64)
    mask = ((1.0 - above) * band * 255).astype(np.uint8)
    return mask, detected
