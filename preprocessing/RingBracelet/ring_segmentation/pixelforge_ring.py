"""Ring front/back segmentation model (ONNX) — extracted from PixelForge.

Source: the coworker's `/pixelForge/deploy/serve.py` (JewelSense v15,
release `v15_layer_refiner_v8_exact_e6`; base model `v13_ownership_v3_w12`).
This module keeps ONLY the ring inference path of that FastAPI service and
drops everything else (HTTP/CORS/frontend, the gemstone endpoint, the
`/health` diagnostics, the environment-variable tuning surface). The numeric
settings below are the validated defaults from `serve.py` / the models'
embedded metadata — PixelForge's own guidance is to not tune them without
re-running its benchmark.

What the two ONNX graphs are:
  * `model.onnx` (ring_unet_v1, 384x384): predicts, from an RGB photo of a
    ring on a plain background, TWO probability maps — the ring matte and the
    "back" band (the part of the shank a finger would hide).
  * `ownership_refiner.onnx` (layer_refiner_v1, 512x512): a learned residual
    that corrects the final front/back ownership.
Everything between the two graphs (`_clean_alpha`, `split_layers`, band
regularisation, speck reassignment, ...) is deterministic NumPy/OpenCV from
`pixelforge_post.py`.

There is NO background-removal step anywhere in PixelForge's ring path: the
ring matte is one of this model's own outputs. This module therefore never
removes a background; how the caller feeds it an already-cut-out image is the
caller's concern (see `front_ownership.py`).

Adaptations from serve.py (behaviour-preserving):
  * no FastAPI / no module-level model load — sessions are created lazily, once
    per process, from a directory resolved by `resolve_model_dir()`;
  * only the ring branch of `_segment_native` / `segment` (the `direct`
    ownership mode and the gemstone paths are not present in these models);
  * `_ring_processing_shape` / `segment` keep the supersampled path for small
    inputs.
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

from pixelforge_post import (
    antialias_subpixel, fill_metal_holes, reassign_back_specks, reassign_front_specks,
    recover_plain_background_edges, refine_plain_background_contour, regularize_back_band,
    remove_alpha_specks, repair_abrupt_front_tip, repair_shoulder_slits,
    repair_upper_ring_opening, resize_layer_actions, resize_layer_partition,
    scale_component_area, select_layer_actions, separate_thin_back_bridge, sharpen_alpha,
    split_layers, trim_background_edge, veto_background, veto_enclosed_background,
)

MODEL_FILE = "model.onnx"
REFINER_FILE = "ownership_refiner.onnx"
# Overrides where the two .onnx files live (deployment relocation) without
# code changes. Default: `models/` beside this file.
MODEL_DIR_ENV = "RING_SEGMENTATION_MODEL_DIR"

# ---- validated defaults from serve.py (do not tune without PixelForge's benchmark) ----
OWNERSHIP_REFINER_THR = 0.9995
OWNERSHIP_REFINER_MARGIN = 0.10
BACK_THR = 0.5
MATTE_THR = 0.5
SHARPEN = 6.0
VETO_TOL = 2.0
ENCLOSED_VETO_TOL = 6.0
ENCLOSED_TEXTURE_TOL = 2.0
BACK_EXPAND = 1
LOW_RES_BACK_EXPAND = 1
LOW_RES_MIN_FRONT_COMPONENT = 64
LOW_RES_MIN_BACK_COMPONENT = 64
EDGE_TRIM = 1.5
EDGE_COLOR_TOL = 12.0
EDGE_TEXTURE_TOL = 18.0
MIN_ALPHA_COMPONENT = 32
MIN_BACK_COMPONENT = 300
ANTIALIAS = 0.6
EDGE_FEATHER = 0.85
SOURCE_REFINE_RADIUS = 4
SOURCE_REFINE_ITERATIONS = 1
OPENING_SMOOTH_WINDOW = 41
OPENING_SMOOTH_DEPTH = 15
SOURCE_EDGE_RADIUS = 6
SOURCE_EDGE_COLOR_TOL = 8.0
BACK_SMOOTH_WINDOW = 41
BACK_SMOOTH_DEPTH = 10
BACK_BRIDGE_THICKNESS = 6
PROCESSING_MIN_SIZE = 1000
PROCESSING_MAX_SIZE = 1600
# The deployed refiner ONNX embeds its validated inference contract.
_ACTION_THRESHOLDS_DEFAULT = "0.9,0.93,0.95"


class RingModelUnavailable(RuntimeError):
    """The model files or the ONNX runtime are not usable in this process."""

    def __init__(self, message: str, kind: str):
        super().__init__(message)
        self.kind = kind  # 'runtime_missing' | 'model_missing' | 'model_invalid'


def resolve_model_dir() -> Path:
    override = os.environ.get(MODEL_DIR_ENV)
    return Path(override) if override else Path(__file__).resolve().parent / "models"


class _Models:
    """Lazily-created ONNX sessions, one pair per process."""

    _instance: "_Models | None" = None

    def __init__(self) -> None:
        try:
            import onnxruntime as ort
        except ImportError as exc:  # the interpreter lacks the runtime
            raise RingModelUnavailable(f"onnxruntime is not installed: {exc}", "runtime_missing") from exc
        model_dir = resolve_model_dir()
        model_path, refiner_path = model_dir / MODEL_FILE, model_dir / REFINER_FILE
        for path in (model_path, refiner_path):
            if not path.is_file():
                raise RingModelUnavailable(f"Ring segmentation model file not found: {path} (install with ring_segmentation/install_models.py)", "model_missing")
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = int(os.environ.get("RING_THREADS", "4"))
        # CPU only: deterministic, and the production graphs were validated on CPU/CUDA
        # parity; an accelerator provider is a deployment decision, not a default.
        providers = ["CPUExecutionProvider"]
        try:
            self.base = ort.InferenceSession(str(model_path), opts, providers=providers)
            self.refiner = ort.InferenceSession(str(refiner_path), opts, providers=providers)
        except Exception as exc:  # corrupt / incompatible graph
            raise RingModelUnavailable(f"Ring segmentation model could not be loaded: {exc}", "model_invalid") from exc
        self.size = int(self.base.get_inputs()[0].shape[-1])
        self.refiner_size = int(self.refiner.get_inputs()[0].shape[-1])
        meta = self.refiner.get_modelmeta().custom_metadata_map
        if meta.get("architecture") != "layer_refiner_v1":
            raise RingModelUnavailable("ownership_refiner.onnx has an unsupported architecture", "model_invalid")
        self.class_thresholds = tuple(float(v) for v in meta.get("recommended_class_thresholds", _ACTION_THRESHOLDS_DEFAULT).split(","))
        self.min_action_component = int(meta.get("recommended_min_action_component", "32"))
        self.action_resize = meta.get("recommended_action_resize", "discrete").strip().lower()

    @classmethod
    def get(cls) -> "_Models":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance


def _forward(bgr):
    m = _Models.get()
    x = cv2.resize(bgr, (m.size, m.size), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    out = m.base.run(None, {"image": x.transpose(2, 0, 1)[None]})[0][0]
    p = 1.0 / (1.0 + np.exp(-np.clip(out, -60.0, 60.0)))
    h, w = bgr.shape[:2]
    return (cv2.resize(p[0], (w, h), interpolation=cv2.INTER_LINEAR),
            cv2.resize(p[1], (w, h), interpolation=cv2.INTER_LINEAR))


def _predict_crop(bgr):
    """Two passes: locate the item, then re-crop tight to match training."""
    h, w = bgr.shape[:2]
    a0, b0 = _forward(bgr)
    ys, xs = np.nonzero(a0 > MATTE_THR)
    alpha = np.zeros((h, w), np.float32)
    back = np.zeros((h, w), np.float32)
    if len(xs):
        pad = int(0.02 * max(np.ptp(xs) + 1, np.ptp(ys) + 1))
        y0, y1 = max(ys.min() - pad, 0), min(ys.max() + 1 + pad, h)
        x0, x1 = max(xs.min() - pad, 0), min(xs.max() + 1 + pad, w)
        ca, cb = _forward(bgr[y0:y1, x0:x1])
        alpha[y0:y1, x0:x1], back[y0:y1, x0:x1] = ca, cb
    else:
        alpha, back = a0, b0
    return alpha, back


def _clean_alpha(alpha, bgr, veto_tol, conservative=False):
    # See serve.py: the 499px-derivative "conservative" path trusts the model's
    # silhouette; the native path applies the full source-guided repairs.
    if conservative:
        alpha = sharpen_alpha(alpha, SHARPEN) if SHARPEN else np.clip(alpha, 0.0, 1.0)
        alpha = remove_alpha_specks(alpha, min_pixels=MIN_ALPHA_COMPONENT, keep_largest=False)
        return antialias_subpixel(alpha, sigma=ANTIALIAS, edge_sigma=EDGE_FEATHER)

    alpha = veto_background(alpha, bgr, tol=veto_tol)
    alpha = fill_metal_holes(alpha, bgr)
    alpha = veto_enclosed_background(alpha, bgr, colour_tol=ENCLOSED_VETO_TOL, texture_tol=ENCLOSED_TEXTURE_TOL)
    alpha = sharpen_alpha(alpha, SHARPEN) if SHARPEN else alpha
    alpha = trim_background_edge(alpha, bgr, radius=EDGE_TRIM, tol=EDGE_COLOR_TOL, texture_tol=EDGE_TEXTURE_TOL)
    alpha = refine_plain_background_contour(alpha, bgr, radius=SOURCE_REFINE_RADIUS, iterations=SOURCE_REFINE_ITERATIONS)
    alpha = repair_upper_ring_opening(alpha, window=OPENING_SMOOTH_WINDOW, max_depth=OPENING_SMOOTH_DEPTH)
    alpha = veto_enclosed_background(alpha, bgr, colour_tol=ENCLOSED_VETO_TOL, texture_tol=ENCLOSED_TEXTURE_TOL)
    alpha = recover_plain_background_edges(alpha, bgr, radius=SOURCE_EDGE_RADIUS, colour_tol=SOURCE_EDGE_COLOR_TOL)
    alpha = fill_metal_holes(alpha, bgr)
    alpha = repair_shoulder_slits(alpha)
    alpha = remove_alpha_specks(alpha, min_pixels=MIN_ALPHA_COMPONENT, keep_largest=False)
    return antialias_subpixel(alpha, sigma=ANTIALIAS, edge_sigma=EDGE_FEATHER)


def _refine_final_ownership(bgr, alpha, base_back):
    """Apply the learned four-class residual to an already-clean final mask."""
    m = _Models.get()
    solid = np.asarray(alpha) > 0.5
    ys, xs = np.nonzero(solid)
    if not len(xs):
        return None
    height, width = solid.shape
    pad = int(round(OWNERSHIP_REFINER_MARGIN * max(np.ptp(ys) + 1, np.ptp(xs) + 1)))
    y0, y1 = max(int(ys.min()) - pad, 0), min(int(ys.max()) + pad + 1, height)
    x0, x1 = max(int(xs.min()) - pad, 0), min(int(xs.max()) + pad + 1, width)
    size = m.refiner_size
    image = cv2.resize(bgr[y0:y1, x0:x1], (size, size), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    coordinates = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    x_coord = np.broadcast_to(coordinates[None, :], (size, size))
    y_coord = np.broadcast_to(coordinates[:, None], (size, size))
    image = np.concatenate((image.transpose(2, 0, 1), x_coord[None], y_coord[None]), axis=0)
    full = cv2.resize(solid[y0:y1, x0:x1].astype(np.float32), (size, size), interpolation=cv2.INTER_NEAREST)
    back = cv2.resize((np.asarray(base_back)[y0:y1, x0:x1] > 0.5).astype(np.float32), (size, size), interpolation=cv2.INTER_NEAREST)
    logits = m.refiner.run(None, {"image": image[None], "full": full[None, None], "back": back[None, None]})[0][0]
    shifted = logits - logits.max(axis=0, keepdims=True)
    exponential = np.exp(np.clip(shifted, -60.0, 0.0))
    probability = exponential / exponential.sum(axis=0, keepdims=True)
    if m.action_resize == "discrete":
        action_min = scale_component_area(m.min_action_component, probability.shape[1:])
        choices = select_layer_actions(
            probability, threshold=OWNERSHIP_REFINER_THR,
            class_thresholds=m.class_thresholds, min_component=action_min)
        return resize_layer_actions(choices, (y0, y1, x0, x1), (height, width))
    native = np.zeros((probability.shape[0], height, width), np.float32)
    for channel in range(probability.shape[0]):
        native[channel, y0:y1, x0:x1] = cv2.resize(probability[channel], (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)
    return native


def _segment_native(bgr, back_expand=None, conservative=False):
    """Return (alpha, front, back) at the supplied working resolution."""
    m = _Models.get()
    alpha, back = _predict_crop(bgr)
    alpha = _clean_alpha(alpha, bgr, VETO_TOL, conservative=conservative)
    ownership_expand = BACK_EXPAND if back_expand is None else int(back_expand)
    a, f, b = split_layers(alpha, back, BACK_THR, sharpen=0, expand=ownership_expand)
    if conservative:
        # The 1000px notch/bridge repairs, the learned residual and the rear
        # component filtering are skipped for supersampled previews; rear
        # topology is resolved after categorical downsampling (see segment()).
        return a, f, b
    f, b = regularize_back_band(a, f, b, window=BACK_SMOOTH_WINDOW, max_depth=BACK_SMOOTH_DEPTH)
    f, b = separate_thin_back_bridge(a, f, b, max_thickness=BACK_BRIDGE_THICKNESS, bgr=bgr)
    f, b = repair_abrupt_front_tip(a, f, b)
    front_min = scale_component_area(16, bgr.shape)
    back_min = scale_component_area(MIN_BACK_COMPONENT, bgr.shape)
    f, b = reassign_front_specks(a, f, b, min_pixels=front_min)
    f, b = reassign_back_specks(a, f, b, min_pixels=back_min)
    actions = _refine_final_ownership(bgr, a, b)
    if actions is not None:
        if actions.ndim == 3:
            action_min = scale_component_area(m.min_action_component, bgr.shape)
            filtered = select_layer_actions(
                actions, threshold=OWNERSHIP_REFINER_THR,
                class_thresholds=m.class_thresholds, min_component=action_min)
        else:
            filtered = actions
        to_background = filtered == 1
        to_front = filtered == 2
        to_back = filtered == 3
        refined_alpha = a.copy()
        refined_alpha[to_background] = 0.0
        added = (to_front | to_back) & (refined_alpha <= 0.5)
        refined_alpha[added] = 1.0
        refined_back = b > 0.5
        refined_back[to_background | to_front] = False
        refined_back[to_back] = True
        refined_back &= refined_alpha > 0.5
        a, f, b = split_layers(refined_alpha, refined_back.astype(np.float32), 0.5, sharpen=0, expand=0)
        if m.action_resize == "probability":
            f, b = reassign_back_specks(a, f, b, min_pixels=back_min)
    return a, f, b


def _ring_processing_shape(image_shape):
    """Bounded supersampled shape for small catalogue previews (see serve.py)."""
    height, width = image_shape[:2]
    shortest, longest = min(height, width), max(height, width)
    if PROCESSING_MIN_SIZE <= 0 or shortest >= PROCESSING_MIN_SIZE or shortest <= 0 or longest <= 0:
        return height, width
    scale = PROCESSING_MIN_SIZE / float(shortest)
    if PROCESSING_MAX_SIZE > 0:
        scale = min(scale, PROCESSING_MAX_SIZE / float(longest))
    if scale <= 1.0:
        return height, width
    return max(height, int(round(height * scale))), max(width, int(round(width * scale)))


def segment(bgr):
    """Return (alpha, front, back) float maps in [0, 1] at the input dimensions.

    `alpha` is the MODEL'S OWN ring matte; `front` + `back` partition it (they
    sum to it). `bgr` is an 8-bit HxWx3 image of the ring on a plain background.
    """
    height, width = bgr.shape[:2]
    work_height, work_width = _ring_processing_shape(bgr.shape)
    if (work_height, work_width) == (height, width):
        return _segment_native(bgr)
    working = cv2.resize(bgr, (work_width, work_height), interpolation=cv2.INTER_LANCZOS4)
    alpha, front, back = _segment_native(working, back_expand=LOW_RES_BACK_EXPAND, conservative=True)
    # Ownership is categorical: downsample the hard class by majority, then
    # apply the one smooth outer matte to exactly one layer per pixel.
    alpha, front, back = resize_layer_partition(alpha, back, (height, width))
    front, back = reassign_front_specks(
        alpha, front, back, min_pixels=LOW_RES_MIN_FRONT_COMPONENT, support_threshold=0.5 / 255.0)
    front, back = reassign_back_specks(
        alpha, front, back, min_pixels=LOW_RES_MIN_BACK_COMPONENT, preserve_aligned_details=True)
    return alpha, front, back
