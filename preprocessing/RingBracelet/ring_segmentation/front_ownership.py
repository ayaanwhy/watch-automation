"""Ring front/back ownership for the Ring & Bracelet runner — the adapter
between our pipeline and the PixelForge-derived model (`pixelforge_ring.py`).

Contract (identical to `shank_mask.generate_wrap_mask`, so the runner's existing
mask step is unchanged): given the preprocessed RGBA image, return
`(mask, detected)` where `mask` is a uint8 HxW map, 255 where the ring's
rear band is hidden behind the finger ("back"), 0 where it is the visible
front; the runner then applies `alpha * (1 - mask/255)` to produce frontImage.

Why an ownership mask and not PixelForge's own front matte:
  * The image we receive is ALREADY background-removed (Universal
    Preprocessing). PixelForge's ring path has no background-removal stage —
    its ring matte is a model output — so re-using that matte would mean a
    second, competing cut-out of the same ring. We keep OUR alpha (so
    `frontFullImage` and the frontImage silhouette stay exactly what
    preprocessing produced: same size, same transparency) and use the model
    only for the decision it is better at: which part of the ring is front and
    which is the hidden rear band.
  * The model expects an RGB photo on a plain background, so the transparent
    image is composited onto flat white (with a white margin, which also keeps
    the model's border-colour estimate from sampling the ring when the
    preprocessing crop is tight). Nothing is removed or re-cut here.
"""
from __future__ import annotations

import numpy as np

# PixelForge's own review heuristic: its training set has back/ring pixel
# fractions of 0.02-0.33; outside 0.02-0.40 the layer split is flagged for review.
REVIEW_BACK_FRACTION = (0.02, 0.40)
CANVAS_MARGIN = 0.08  # white margin around the composite, fraction of the long side


class RingSegmentationError(RuntimeError):
    """A ring-segmentation failure with a stable machine-readable kind.

    `str(exc)` starts with `[RING_SEGMENTATION_<KIND>]` — a token owned by this
    runner (like a Python exception class name) that the automation engine
    parses to build its structured AutomationError. The rest is the technical
    detail.
    """

    KINDS = ("MODEL_UNAVAILABLE", "INFERENCE_FAILED", "OUTPUT_MISSING", "OUTPUT_INVALID", "RUNTIME_ERROR")

    def __init__(self, kind: str, detail: str):
        assert kind in self.KINDS, kind
        super().__init__(f"[RING_SEGMENTATION_{kind}] {detail}")
        self.kind = kind
        self.detail = detail


def _load_model():
    """Import the model module lazily: bracelets never reach this, and a
    missing onnxruntime becomes a structured error, not an ImportError."""
    try:
        import pixelforge_ring as model
    except ImportError as exc:
        raise RingSegmentationError("RUNTIME_ERROR", f"The ring segmentation runtime could not be imported: {exc}") from exc
    return model


def preflight() -> None:
    """Fail fast (before any image) if the model cannot be used at all."""
    model = _load_model()
    try:
        model._Models.get()
    except model.RingModelUnavailable as exc:
        kind = "RUNTIME_ERROR" if exc.kind == "runtime_missing" else "MODEL_UNAVAILABLE"
        raise RingSegmentationError(kind, str(exc)) from exc
    except Exception as exc:
        raise RingSegmentationError("MODEL_UNAVAILABLE", f"{type(exc).__name__}: {exc}") from exc


def _composite_on_white(rgba: np.ndarray) -> tuple[np.ndarray, int]:
    """8-bit BGR image of the ring on flat white with a white margin. Returns
    (bgr, margin_px)."""
    import cv2

    alpha = rgba[..., 3:4].astype(np.float32) / 255.0
    rgb = rgba[..., :3].astype(np.float32) * alpha + 255.0 * (1.0 - alpha)
    bgr = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)[..., ::-1]
    margin = int(round(CANVAS_MARGIN * max(rgba.shape[:2])))
    if margin:
        bgr = cv2.copyMakeBorder(bgr, margin, margin, margin, margin, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    return np.ascontiguousarray(bgr), margin


def generate_ring_model_mask(rgba: np.ndarray) -> tuple[np.ndarray, bool]:
    """Return (mask, detected) — see the module docstring."""
    if rgba is None or rgba.ndim != 3 or rgba.shape[2] != 4 or rgba.dtype != np.uint8:
        raise RingSegmentationError("OUTPUT_INVALID", "The ring segmentation input must be an 8-bit RGBA image.")
    height, width = rgba.shape[:2]
    if not np.any(rgba[..., 3] > 12):
        raise RingSegmentationError("OUTPUT_MISSING", "The image has no visible content to segment.")

    model = _load_model()
    preflight()  # cheap after the first call: sessions are cached per process
    bgr, margin = _composite_on_white(rgba)
    try:
        alpha, _front, back = model.segment(bgr)
    except RingSegmentationError:
        raise
    except model.RingModelUnavailable as exc:
        raise RingSegmentationError("MODEL_UNAVAILABLE", str(exc)) from exc
    except Exception as exc:  # onnxruntime / OpenCV / NumPy failure inside inference
        raise RingSegmentationError("INFERENCE_FAILED", f"{type(exc).__name__}: {exc}") from exc

    expected = bgr.shape[:2]
    if alpha.shape != expected or back.shape != expected:
        raise RingSegmentationError("OUTPUT_INVALID", f"The model returned {alpha.shape}/{back.shape} maps for a {expected} input.")
    if not (np.all(np.isfinite(alpha)) and np.all(np.isfinite(back))):
        raise RingSegmentationError("OUTPUT_INVALID", "The model returned non-finite values.")

    window = (slice(margin, margin + height), slice(margin, margin + width))
    alpha, back = alpha[window], back[window]
    ring_px = int((alpha > 0.5).sum())
    if ring_px == 0:
        raise RingSegmentationError("OUTPUT_MISSING", "The model found no ring in the image.")

    # Share of the model's matte that is rear band. front + back partition the
    # matte, so this is 1 inside the rear band and 0 in the front — including
    # at the soft outer edge, where both are scaled by the same coverage.
    ownership = np.where(alpha > 1e-3, np.clip(back / np.maximum(alpha, 1e-3), 0.0, 1.0), 0.0)
    mask = np.rint(ownership * 255.0).astype(np.uint8)

    back_fraction = int((back > 0.5).sum()) / ring_px
    detected = REVIEW_BACK_FRACTION[0] <= back_fraction <= REVIEW_BACK_FRACTION[1]
    return mask, bool(detected)
