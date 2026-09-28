"""Ring front/back segmentation service.

Runs the exported ONNX graph without a torch dependency. Returns the three
RGBA layers the frontend already composites: back -> hand photo -> front.

    uvicorn deploy.serve:app --host 0.0.0.0 --port 8200
"""

import base64
import os
import time

import cv2
import numpy as np
import onnxruntime as ort

from vto.post import (antialias_subpixel, clean_gem_silhouette, decontaminate,
                      fill_metal_holes,
                      refine_plain_background_contour, regularize_back_band,
                      recover_plain_background_edges,
                      repair_abrupt_front_tip, repair_shoulder_slits,
                      repair_upper_ring_opening,
                      separate_thin_back_bridge,
                      reassign_back_specks, reassign_front_specks,
                      remove_alpha_specks, resize_layer_actions,
                      resize_layer_partition,
                      scale_component_area, select_layer_actions, sharpen_alpha,
                      smooth_gem_matte, split_layers, to_rgba,
                      trim_background_edge, veto_background,
                      veto_enclosed_background)
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

MODEL = os.environ.get("RING_MODEL", "deploy/model.onnx")
SIZE_OVERRIDE = os.environ.get("RING_SIZE")
PROVIDER_OVERRIDE = os.environ.get("RING_PROVIDER")
OWNERSHIP_REFINER_MODEL = os.environ.get(
    "RING_OWNERSHIP_REFINER", "deploy/ownership_refiner.onnx")
OWNERSHIP_REFINER_THR = float(os.environ.get("RING_REFINER_THR", "0.9995"))
_REFINER_CLASS_THRESHOLDS_ENV = os.environ.get(
    "RING_REFINER_CLASS_THRESHOLDS")
_MIN_REFINER_ACTION_COMPONENT_ENV = os.environ.get(
    "RING_MIN_REFINER_ACTION_COMPONENT")
_LAYER_REFINER_RESIZE_ENV = os.environ.get("RING_LAYER_REFINER_RESIZE")
OWNERSHIP_REFINER_MARGIN = float(os.environ.get("RING_REFINER_MARGIN", "0.10"))
BACK_THR = float(os.environ.get("RING_BACK_THR", os.environ.get("RING_THR", "0.5")))
MATTE_THR = float(os.environ.get("RING_MATTE_THR", "0.5"))
SHARPEN = float(os.environ.get("RING_SHARPEN", "6.0"))
VETO_TOL = float(os.environ.get("RING_VETO_TOL", "2.0"))
GEM_VETO_TOL = float(os.environ.get("GEM_VETO_TOL", "6.0"))
GEM_EDGE_ERODE = int(os.environ.get("GEM_EDGE_ERODE", "1"))
GEM_CONTOUR_EPSILON = float(os.environ.get(
    "GEM_CONTOUR_EPSILON", os.environ.get("GEM_CONTOUR_SMOOTH", "1.2")))
GEM_CONTOUR_SUPERSAMPLE = int(os.environ.get(
    "GEM_CONTOUR_SUPERSAMPLE", "8"))
GEM_CANVAS_PX = int(os.environ.get("GEM_CANVAS_PX", "500"))
GEM_CANVAS_MM = float(os.environ.get("GEM_CANVAS_MM", "20"))
GEM_MAX_DIMENSION_MM = float(os.environ.get(
    "GEM_MAX_DIMENSION_MM", str(GEM_CANVAS_MM)))
GEM_DEFAULT_WIDTH_MM = float(os.environ.get("GEM_DEFAULT_WIDTH_MM", "10"))
GEM_DEFAULT_HEIGHT_MM = float(os.environ.get("GEM_DEFAULT_HEIGHT_MM", "10"))
RECOMMENDED_INPUT = int(os.environ.get("RING_RECOMMENDED_INPUT", "1000"))
PROCESSING_MIN_SIZE = int(os.environ.get(
    "RING_PROCESSING_MIN_SIZE", str(RECOMMENDED_INPUT)))
PROCESSING_MAX_SIZE = int(os.environ.get("RING_PROCESSING_MAX_SIZE", "1600"))
ENCLOSED_VETO_TOL = float(os.environ.get("RING_ENCLOSED_VETO_TOL", "6.0"))
ENCLOSED_TEXTURE_TOL = float(os.environ.get("RING_ENCLOSED_TEXTURE_TOL", "2.0"))
BACK_EXPAND = int(os.environ.get("RING_BACK_EXPAND", "1"))
# Keep the trained one-pixel ownership expansion on the 1000px working raster;
# hard categorical downsampling then preserves narrow rear halo/prong details
# without blending the internal seam.  This remains separately configurable
# from the native reviewed-correction path.
LOW_RES_BACK_EXPAND = int(os.environ.get("RING_LOW_RES_BACK_EXPAND", "1"))
# A 499px PNG can contain detached one-pixel ownership dashes even when those
# regions are joined in float space by alpha too faint to survive PNG encoding.
# Evaluate this cleanup in the encoded support domain and keep the threshold
# scoped to legacy low-resolution previews so native reviewed masks do not
# change.
LOW_RES_MIN_FRONT_COMPONENT = int(os.environ.get(
    "RING_LOW_RES_MIN_FRONT_COMPONENT", "64"))
LOW_RES_MIN_BACK_COMPONENT = int(os.environ.get(
    "RING_LOW_RES_MIN_BACK_COMPONENT", "64"))
EDGE_TRIM = float(os.environ.get("RING_EDGE_TRIM", "1.5"))
EDGE_COLOR_TOL = float(os.environ.get("RING_EDGE_COLOR_TOL", "12.0"))
EDGE_TEXTURE_TOL = float(os.environ.get("RING_EDGE_TEXTURE_TOL", "18.0"))
MIN_ALPHA_COMPONENT = int(os.environ.get("RING_MIN_ALPHA_COMPONENT", "32"))
MIN_BACK_COMPONENT = int(os.environ.get("RING_MIN_BACK_COMPONENT", "300"))
ANTIALIAS = float(os.environ.get("RING_ANTIALIAS", "0.6"))
EDGE_FEATHER = float(os.environ.get("RING_EDGE_FEATHER", "0.85"))
SOURCE_REFINE_RADIUS = int(os.environ.get("RING_SOURCE_REFINE_RADIUS", "4"))
SOURCE_REFINE_ITERATIONS = int(os.environ.get("RING_SOURCE_REFINE_ITERATIONS", "1"))
OPENING_SMOOTH_WINDOW = int(os.environ.get("RING_OPENING_SMOOTH_WINDOW", "41"))
OPENING_SMOOTH_DEPTH = int(os.environ.get("RING_OPENING_SMOOTH_DEPTH", "15"))
SOURCE_EDGE_RADIUS = int(os.environ.get("RING_SOURCE_EDGE_RADIUS", "6"))
SOURCE_EDGE_COLOR_TOL = float(os.environ.get("RING_SOURCE_EDGE_COLOR_TOL", "8"))
BACK_SMOOTH_WINDOW = int(os.environ.get("RING_BACK_SMOOTH_WINDOW", "41"))
BACK_SMOOTH_DEPTH = int(os.environ.get("RING_BACK_SMOOTH_DEPTH", "10"))
BACK_BRIDGE_THICKNESS = int(os.environ.get("RING_BACK_BRIDGE_THICKNESS", "6"))

if (GEM_CANVAS_PX <= 0 or not np.isfinite(GEM_CANVAS_MM) or
        GEM_CANVAS_MM <= 0):
    raise RuntimeError("gemstone canvas dimensions must be positive")
if (not np.isfinite(GEM_MAX_DIMENSION_MM) or GEM_MAX_DIMENSION_MM <= 0 or
        GEM_MAX_DIMENSION_MM > GEM_CANVAS_MM):
    raise RuntimeError(
        "maximum gemstone dimension must fit inside GEM_CANVAS_MM")
if any(not np.isfinite(value) or value <= 0 or value > GEM_MAX_DIMENSION_MM
       for value in (GEM_DEFAULT_WIDTH_MM, GEM_DEFAULT_HEIGHT_MM)):
    raise RuntimeError(
        "default gemstone dimensions must not exceed GEM_MAX_DIMENSION_MM")

_opts = ort.SessionOptions()
_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
_opts.intra_op_num_threads = int(os.environ.get("RING_THREADS", "4"))
_available_providers = ort.get_available_providers()
if PROVIDER_OVERRIDE:
    if PROVIDER_OVERRIDE not in _available_providers:
        raise RuntimeError(
            f"RING_PROVIDER={PROVIDER_OVERRIDE} is unavailable; "
            f"installed providers: {_available_providers}")
    # A requested accelerator is a correctness requirement for benchmarks.
    # Prevent ONNX Runtime from silently assigning unsupported graph nodes to
    # CPU and producing a result that was only partly GPU-executed.
    if PROVIDER_OVERRIDE != "CPUExecutionProvider":
        _opts.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()
    _providers = [PROVIDER_OVERRIDE]
else:
    _providers = _available_providers
_sess = ort.InferenceSession(MODEL, _opts, providers=_providers)
if PROVIDER_OVERRIDE and _sess.get_providers()[0] != PROVIDER_OVERRIDE:
    raise RuntimeError(
        f"requested {PROVIDER_OVERRIDE}, session activated {_sess.get_providers()}")
_model_meta = _sess.get_modelmeta().custom_metadata_map
OWNERSHIP_MODE = os.environ.get(
    "RING_OWNERSHIP_MODE", _model_meta.get("ownership_mode", "legacy"))
if OWNERSHIP_MODE not in ("legacy", "direct"):
    raise RuntimeError(
        f"unsupported ownership mode {OWNERSHIP_MODE!r}; expected legacy or direct")
_graph_size = _sess.get_inputs()[0].shape[-1]
SIZE = int(SIZE_OVERRIDE) if SIZE_OVERRIDE else int(_graph_size)
if isinstance(_graph_size, int) and SIZE != _graph_size:
    raise RuntimeError(f"RING_SIZE={SIZE} does not match model input {_graph_size}")

_ownership_refiner_sess = None
_ownership_refiner_size = None
_ownership_refiner_architecture = None
refiner_meta = {}
if OWNERSHIP_REFINER_MODEL:
    if OWNERSHIP_MODE != "legacy":
        raise RuntimeError(
            "RING_OWNERSHIP_REFINER requires a legacy base ownership model")
    _ownership_refiner_sess = ort.InferenceSession(
        OWNERSHIP_REFINER_MODEL, _opts, providers=_providers)
    refiner_meta = _ownership_refiner_sess.get_modelmeta().custom_metadata_map
    _ownership_refiner_architecture = refiner_meta.get("architecture")
    if _ownership_refiner_architecture not in (
            "ownership_refiner_v2", "layer_refiner_v1"):
        raise RuntimeError("RING_OWNERSHIP_REFINER has unsupported architecture")
    _ownership_refiner_size = int(
        _ownership_refiner_sess.get_inputs()[0].shape[-1])

# A layer-refiner export carries its validated inference contract. Explicit
# environment variables still override these recommendations for experiments,
# while ordinary API and benchmark runs use the exact settings selected during
# validation instead of silently reverting to legacy defaults.
_refiner_class_thresholds = (
    _REFINER_CLASS_THRESHOLDS_ENV
    if _REFINER_CLASS_THRESHOLDS_ENV is not None else
    refiner_meta.get("recommended_class_thresholds"))
OWNERSHIP_REFINER_CLASS_THRESHOLDS = (
    tuple(float(value) for value in _refiner_class_thresholds.split(","))
    if _refiner_class_thresholds else None)
if (OWNERSHIP_REFINER_CLASS_THRESHOLDS is not None and
        len(OWNERSHIP_REFINER_CLASS_THRESHOLDS) != 3):
    raise RuntimeError(
        "RING_REFINER_CLASS_THRESHOLDS must be background,front,back")
_min_refiner_action_component = (
    _MIN_REFINER_ACTION_COMPONENT_ENV
    if _MIN_REFINER_ACTION_COMPONENT_ENV is not None else
    refiner_meta.get("recommended_min_action_component", "32"))
MIN_REFINER_ACTION_COMPONENT = int(_min_refiner_action_component)
if MIN_REFINER_ACTION_COMPONENT < 0:
    raise RuntimeError("RING_MIN_REFINER_ACTION_COMPONENT must be non-negative")
LAYER_REFINER_RESIZE = (
    _LAYER_REFINER_RESIZE_ENV
    if _LAYER_REFINER_RESIZE_ENV is not None else
    refiner_meta.get("recommended_action_resize", "discrete"))
LAYER_REFINER_RESIZE = LAYER_REFINER_RESIZE.strip().lower()
if LAYER_REFINER_RESIZE not in ("discrete", "probability"):
    raise RuntimeError(
        "RING_LAYER_REFINER_RESIZE must be discrete or probability")

app = FastAPI(title="ring-layers", version="1.0")
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Source-Width", "X-Source-Height",
        "X-Crop-X", "X-Crop-Y", "X-Crop-Width", "X-Crop-Height",
        "X-Gem-Width-Mm", "X-Gem-Height-Mm",
        "X-Gem-Canvas-Px", "X-Gem-Canvas-Mm", "X-Gem-Rotated",
        "X-Output-Width", "X-Output-Height",
    ],
    max_age=86400,
)
WEB_INDEX = os.path.join(os.path.dirname(__file__), "web", "index.html")


@app.get("/", include_in_schema=False)
def web_ui():
    """Self-contained upload and layer-inspection frontend."""
    return FileResponse(WEB_INDEX, media_type="text/html",
                        headers={"Cache-Control": "no-store"})


def _forward(bgr):
    x = cv2.resize(bgr, (SIZE, SIZE), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    out = _sess.run(None, {"image": x.transpose(2, 0, 1)[None]})[0][0]
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
        pad = int(0.02 * max(xs.ptp() + 1, ys.ptp() + 1))
        y0, y1 = max(ys.min() - pad, 0), min(ys.max() + 1 + pad, h)
        x0, x1 = max(xs.min() - pad, 0), min(xs.max() + 1 + pad, w)
        ca, cb = _forward(bgr[y0:y1, x0:x1])
        alpha[y0:y1, x0:x1], back[y0:y1, x0:x1] = ca, cb
    else:
        alpha, back = a0, b0

    return alpha, back


def _clean_alpha(alpha, bgr, veto_tol, keep_largest=False, gemstone=False,
                 conservative=False):
    # The 499px catalogue derivatives already match the raster on which the
    # base model was trained.  The larger source-geometry repairs below were
    # introduced for the 1000px configurator benchmark; when a 499px preview
    # is first enlarged they turn a one-pixel uncertainty into a multi-pixel
    # mutation, filling genuine ring openings and growing pale shoulders.
    # For that compatibility path, trust the model's binary silhouette and
    # only steepen, de-speckle and antialias it.  The native benchmark path is
    # deliberately unchanged so reviewed corrections retain their contract.
    if conservative and not gemstone:
        alpha = sharpen_alpha(alpha, SHARPEN) if SHARPEN else np.clip(
            alpha, 0.0, 1.0)
        alpha = remove_alpha_specks(
            alpha, min_pixels=MIN_ALPHA_COMPONENT,
            keep_largest=keep_largest)
        return antialias_subpixel(
            alpha, sigma=ANTIALIAS, edge_sigma=EDGE_FEATHER)

    alpha = veto_background(alpha, bgr, tol=veto_tol)
    alpha = fill_metal_holes(alpha, bgr)
    alpha = veto_enclosed_background(alpha, bgr,
                                     colour_tol=ENCLOSED_VETO_TOL,
                                     texture_tol=ENCLOSED_TEXTURE_TOL)
    alpha = sharpen_alpha(alpha, SHARPEN) if SHARPEN else alpha
    alpha = trim_background_edge(alpha, bgr, radius=EDGE_TRIM,
                                 tol=EDGE_COLOR_TOL,
                                 texture_tol=EDGE_TEXTURE_TOL)
    if not gemstone:
        alpha = refine_plain_background_contour(
            alpha, bgr, radius=SOURCE_REFINE_RADIUS,
            iterations=SOURCE_REFINE_ITERATIONS)
        alpha = repair_upper_ring_opening(
            alpha, window=OPENING_SMOOTH_WINDOW,
            max_depth=OPENING_SMOOTH_DEPTH)
        # The geometric opening repair can bridge a notch with pixels that are
        # truly flat catalogue canvas (most visible below flower halos).  Run
        # the strict colour+texture veto again after that geometry mutation;
        # it removes only hole-connected, textureless background and leaves
        # faceted stones and detailed metal intact.
        alpha = veto_enclosed_background(
            alpha, bgr, colour_tol=ENCLOSED_VETO_TOL,
            texture_tol=ENCLOSED_TEXTURE_TOL)
        alpha = recover_plain_background_edges(
            alpha, bgr, radius=SOURCE_EDGE_RADIUS,
            colour_tol=SOURCE_EDGE_COLOR_TOL)
        # Geometry repair can close around a dark metal groove that was
        # connected to the coarse opening earlier.  Fill that newly enclosed,
        # source-supported slit before antialiasing.
        alpha = fill_metal_holes(alpha, bgr)
        alpha = repair_shoulder_slits(alpha)
    alpha = remove_alpha_specks(alpha, min_pixels=MIN_ALPHA_COMPONENT,
                                keep_largest=keep_largest)
    if gemstone:
        alpha = clean_gem_silhouette(alpha, bgr=bgr,
                                     erode=GEM_EDGE_ERODE)
        alpha = remove_alpha_specks(alpha, keep_largest=True)
    if gemstone:
        alpha = smooth_gem_matte(
            alpha, epsilon=GEM_CONTOUR_EPSILON,
            supersample=GEM_CONTOUR_SUPERSAMPLE if ANTIALIAS > 0 else 1)
    else:
        alpha = antialias_subpixel(alpha, sigma=ANTIALIAS,
                                   edge_sigma=EDGE_FEATHER)
    # Gem inputs contain one stone.  Erosion can disconnect a reflection
    # remnant which was joined to it before cleanup, so filter once more after
    # antialiasing using the encoded-alpha support.
    if gemstone:
        alpha = remove_alpha_specks(alpha, keep_largest=True)
    return alpha


def _refine_final_ownership(bgr, alpha, base_back):
    """Apply the optional learned residual to an already-clean final mask."""
    if _ownership_refiner_sess is None:
        return None
    solid = np.asarray(alpha) > 0.5
    ys, xs = np.nonzero(solid)
    if not len(xs):
        return None
    height, width = solid.shape
    pad = int(round(OWNERSHIP_REFINER_MARGIN *
                    max(np.ptp(ys) + 1, np.ptp(xs) + 1)))
    y0, y1 = max(int(ys.min()) - pad, 0), min(int(ys.max()) + pad + 1,
                                              height)
    x0, x1 = max(int(xs.min()) - pad, 0), min(int(xs.max()) + pad + 1,
                                              width)
    size = _ownership_refiner_size
    image = cv2.resize(bgr[y0:y1, x0:x1], (size, size),
                       interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    coordinates = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    x_coord = np.broadcast_to(coordinates[None, :], (size, size))
    y_coord = np.broadcast_to(coordinates[:, None], (size, size))
    image = np.concatenate((image.transpose(2, 0, 1),
                            x_coord[None], y_coord[None]), axis=0)
    full = cv2.resize(solid[y0:y1, x0:x1].astype(np.float32),
                      (size, size), interpolation=cv2.INTER_NEAREST)
    back = cv2.resize((np.asarray(base_back)[y0:y1, x0:x1] > 0.5).astype(
                      np.float32), (size, size), interpolation=cv2.INTER_NEAREST)
    logits = _ownership_refiner_sess.run(None, {
        "image": image[None],
        "full": full[None, None],
        "back": back[None, None],
    })[0][0]
    if _ownership_refiner_architecture == "layer_refiner_v1":
        shifted = logits - logits.max(axis=0, keepdims=True)
        exponential = np.exp(np.clip(shifted, -60.0, 0.0))
        probability = exponential / exponential.sum(axis=0, keepdims=True)
        if LAYER_REFINER_RESIZE == "discrete":
            action_min = scale_component_area(
                MIN_REFINER_ACTION_COMPONENT, probability.shape[1:])
            choices = select_layer_actions(
                probability, threshold=OWNERSHIP_REFINER_THR,
                class_thresholds=OWNERSHIP_REFINER_CLASS_THRESHOLDS,
                min_component=action_min)
            return resize_layer_actions(
                choices, (y0, y1, x0, x1), (height, width))
    else:
        probability = 1.0 / (1.0 + np.exp(-np.clip(logits, -60.0, 60.0)))
    native = np.zeros((probability.shape[0], height, width), np.float32)
    for channel in range(probability.shape[0]):
        native[channel, y0:y1, x0:x1] = cv2.resize(
            probability[channel], (x1 - x0, y1 - y0),
            interpolation=cv2.INTER_LINEAR)
    return native


def _segment_native(bgr, back_expand=None, conservative=False):
    """Return layers at the supplied working resolution."""
    alpha, back = _predict_crop(bgr)
    alpha = _clean_alpha(
        alpha, bgr, VETO_TOL, conservative=conservative)
    direct = OWNERSHIP_MODE == "direct"
    ownership_expand = BACK_EXPAND if back_expand is None else int(back_expand)
    a, f, b = split_layers(alpha, back, BACK_THR, sharpen=0,
                           expand=0 if direct else ownership_expand)
    if direct:
        # The student is supervised on final API ownership masks.  Applying
        # the legacy seam geometry again would transform the target twice and
        # was the cause of the rejected v14 experiments.  A component-level
        # topology invariant is still needed after thresholding: detached rear
        # logits are classification noise, not a seam transformation.  Move
        # them into front while retaining a valid pair of occluded band halves.
        back_min = scale_component_area(MIN_BACK_COMPONENT, bgr.shape)
        f, b = reassign_back_specks(a, f, b, min_pixels=back_min)
        return a, f, b, decontaminate(bgr, a)
    if conservative:
        # Do not run the 1000px notch/bridge repairs, learned residual or rear
        # component filtering here: those were supervised against the native
        # configurator cleanup.  Rear topology is resolved after categorical
        # downsampling, where aligned lower halo/prong details can be
        # distinguished from random single-pixel ownership noise.
        return a, f, b, decontaminate(bgr, a)
    f, b = regularize_back_band(a, f, b, window=BACK_SMOOTH_WINDOW,
                                max_depth=BACK_SMOOTH_DEPTH)
    f, b = separate_thin_back_bridge(
        a, f, b, max_thickness=BACK_BRIDGE_THICKNESS, bgr=bgr)
    f, b = repair_abrupt_front_tip(a, f, b)
    front_min = scale_component_area(16, bgr.shape)
    back_min = scale_component_area(MIN_BACK_COMPONENT, bgr.shape)
    f, b = reassign_front_specks(a, f, b, min_pixels=front_min)
    f, b = reassign_back_specks(a, f, b, min_pixels=back_min)
    actions = _refine_final_ownership(bgr, a, b)
    if actions is not None:
        if _ownership_refiner_architecture == "layer_refiner_v1":
            if actions.ndim == 3:
                action_min = scale_component_area(
                    MIN_REFINER_ACTION_COMPONENT, bgr.shape)
                filtered = select_layer_actions(
                    actions, threshold=OWNERSHIP_REFINER_THR,
                    class_thresholds=OWNERSHIP_REFINER_CLASS_THRESHOLDS,
                    min_component=action_min)
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
            a, f, b = split_layers(
                refined_alpha, refined_back.astype(np.float32), 0.5,
                sharpen=0, expand=0)
            if LAYER_REFINER_RESIZE == "probability":
                f, b = reassign_back_specks(a, f, b, min_pixels=back_min)
        else:
            action_min = scale_component_area(
                MIN_REFINER_ACTION_COMPONENT, bgr.shape)
            remove = ((actions[0] > OWNERSHIP_REFINER_THR) &
                      (actions[0] > actions[1]))
            add = ((actions[1] > OWNERSHIP_REFINER_THR) &
                   (actions[1] > actions[0]))
            remove = remove_alpha_specks(
                remove.astype(np.float32), min_pixels=action_min) > 0.5
            add = remove_alpha_specks(
                add.astype(np.float32), min_pixels=action_min) > 0.5
            refined_back = b > 0.5
            refined_back[remove] = False
            refined_back[add & (a > 0.5)] = True
            _, f, b = split_layers(a, refined_back.astype(np.float32), 0.5,
                                   sharpen=0, expand=0)
            # The legacy ownership refiner did not supervise topology, so its
            # output still needs the old detached-component guard.  The
            # four-class layer refiner is trained directly on the final masks;
            # applying this guard after one sparse seam edit can delete an
            # otherwise valid occluded band half and amplify one wrong pixel
            # into thousands.
            f, b = reassign_back_specks(a, f, b, min_pixels=back_min)
    return a, f, b, decontaminate(bgr, a)


def _ring_processing_shape(image_shape):
    """Choose a bounded supersampled shape for small catalogue previews.

    The storefront's legacy JPGs are 499px derivatives of much larger edited
    assets.  Running native-pixel contour cleanup on those derivatives exposes
    the 384px network staircase.  Work at the catalogue validation size and
    area-downsample the complementary masks to recover subpixel coverage.
    """
    height, width = image_shape[:2]
    shortest, longest = min(height, width), max(height, width)
    if (PROCESSING_MIN_SIZE <= 0 or shortest >= PROCESSING_MIN_SIZE or
            shortest <= 0 or longest <= 0):
        return height, width
    scale = PROCESSING_MIN_SIZE / float(shortest)
    if PROCESSING_MAX_SIZE > 0:
        scale = min(scale, PROCESSING_MAX_SIZE / float(longest))
    if scale <= 1.0:
        return height, width
    return max(height, int(round(height * scale))), max(
        width, int(round(width * scale)))


def segment(bgr):
    """Return smooth full/front/back layers at the uploaded dimensions."""
    height, width = bgr.shape[:2]
    work_height, work_width = _ring_processing_shape(bgr.shape)
    if (work_height, work_width) == (height, width):
        return _segment_native(bgr)

    working = cv2.resize(
        bgr, (work_width, work_height), interpolation=cv2.INTER_LANCZOS4)
    alpha, front, back, _ = _segment_native(
        working, back_expand=LOW_RES_BACK_EXPAND, conservative=True)
    # Ownership is categorical, unlike the outer silhouette.  Area-resizing
    # the back alpha and subtracting it from the full matte shares seam pixels
    # between both PNGs; those fractions show up as floating hairlines over a
    # hand.  Downsample the hard class by majority, then apply the one smooth
    # outer matte to exactly one layer per pixel.
    alpha, front, back = resize_layer_partition(
        alpha, back, (height, width))
    front, back = reassign_front_specks(
        alpha, front, back, min_pixels=LOW_RES_MIN_FRONT_COMPONENT,
        support_threshold=0.5 / 255.0)
    front, back = reassign_back_specks(
        alpha, front, back, min_pixels=LOW_RES_MIN_BACK_COMPONENT,
        preserve_aligned_details=True)
    return alpha, front, back, decontaminate(bgr, alpha)


def segment_gem(bgr, source_alpha=None):
    """Return matte-only layers for one loose gemstone on a plain background."""
    if source_alpha is not None:
        embedded = np.clip(np.asarray(source_alpha, np.float32), 0.0, 1.0)
        if embedded.shape != bgr.shape[:2]:
            raise ValueError("source alpha dimensions do not match image")
        if np.any(embedded < 1.0):
            return (embedded, embedded.copy(), np.zeros_like(embedded),
                    np.asarray(bgr, np.uint8).copy())
    alpha, _ = _predict_crop(bgr)
    alpha = _clean_alpha(alpha, bgr, GEM_VETO_TOL, keep_largest=True,
                         gemstone=True)
    return alpha, alpha.copy(), np.zeros_like(alpha), decontaminate(bgr, alpha)


def _png(bgr, mask):
    ok, buf = cv2.imencode(".png", to_rgba(bgr, mask))
    if not ok:
        raise HTTPException(500, "png encode failed")
    return buf.tobytes()


def _alpha_png(mask):
    """Encode a matte as a compact RGBA PNG suitable for a CSS alpha mask."""
    alpha = np.rint(np.clip(mask, 0.0, 1.0) * 255.0).astype(np.uint8)
    rgba = np.zeros((*alpha.shape, 4), np.uint8)
    rgba[..., 3] = alpha
    ok, buf = cv2.imencode(".png", rgba)
    if not ok:
        raise HTTPException(500, "alpha png encode failed")
    return buf.tobytes()


def _ownership_png(full, layer):
    """Encode layer/full coverage so CSS masking preserves edge alpha once."""
    full = np.clip(np.asarray(full, np.float32), 0.0, 1.0)
    layer = np.clip(np.asarray(layer, np.float32), 0.0, full)
    ownership = np.divide(layer, full, out=np.zeros_like(layer),
                          where=full > 0.0)
    return _alpha_png(ownership)


def _tight_crop(bgr, masks):
    """Crop RGB and every aligned matte to the encoded full-mask support.

    Ring ownership layers must remain in exactly the same coordinate system,
    so the first mask (the full matte) defines one crop for the whole tuple.
    Support is evaluated after 8-bit alpha rounding, matching the pixels that
    will actually be present in the returned PNG.
    """
    image = np.asarray(bgr)
    aligned = tuple(np.asarray(mask) for mask in masks)
    if not aligned:
        raise ValueError("at least one mask is required")
    if image.ndim != 3 or any(
            mask.shape != image.shape[:2] for mask in aligned):
        raise ValueError("image and mask dimensions do not match")

    support = np.rint(np.clip(aligned[0], 0.0, 1.0) * 255.0) > 0
    ys, xs = np.nonzero(support)
    height, width = image.shape[:2]
    if len(xs):
        x0, y0 = int(xs.min()), int(ys.min())
        x1, y1 = int(xs.max()) + 1, int(ys.max()) + 1
    else:
        x0, y0, x1, y1 = 0, 0, width, height

    crop = (slice(y0, y1), slice(x0, x1))
    bounds = {"x": x0, "y": y0, "width": x1 - x0,
              "height": y1 - y0}
    return (np.ascontiguousarray(image[crop]),
            tuple(np.ascontiguousarray(mask[crop]) for mask in aligned),
            bounds)


def _crop_headers(source_shape, bounds):
    height, width = source_shape[:2]
    return {
        "X-Source-Width": str(width),
        "X-Source-Height": str(height),
        "X-Crop-X": str(bounds["x"]),
        "X-Crop-Y": str(bounds["y"]),
        "X-Crop-Width": str(bounds["width"]),
        "X-Crop-Height": str(bounds["height"]),
    }


def _gem_dimensions(width, height):
    """Resolve the physical gemstone size without silently guessing one axis."""
    if width is None and height is None:
        return GEM_DEFAULT_WIDTH_MM, GEM_DEFAULT_HEIGHT_MM
    if width is None or height is None:
        raise HTTPException(
            422, "width and height must be sent together, in millimetres")
    width, height = float(width), float(height)
    if any(not np.isfinite(value) or value <= 0 for value in (width, height)):
        raise HTTPException(422, "width and height must be positive numbers")
    if width > GEM_MAX_DIMENSION_MM or height > GEM_MAX_DIMENSION_MM:
        raise HTTPException(
            422,
            f"width and height must not exceed {GEM_MAX_DIMENSION_MM:g} mm")
    return width, height


def _resize_gem_content(bgr, alpha, target_width):
    """Resize colour and alpha together without dark transparent-edge bleed."""
    source_height, source_width = alpha.shape
    target_height = max(1, int(round(
        source_height * target_width / float(source_width))))
    size = (int(target_width), target_height)
    alpha = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    premultiplied = np.asarray(bgr, np.float32) * alpha[..., None]
    resized_alpha = np.clip(cv2.resize(
        alpha, size, interpolation=cv2.INTER_LANCZOS4), 0.0, 1.0)
    resized_premultiplied = cv2.resize(
        premultiplied, size, interpolation=cv2.INTER_LANCZOS4)
    resized_bgr = np.zeros((*resized_alpha.shape, 3), np.float32)
    np.divide(
        resized_premultiplied, resized_alpha[..., None], out=resized_bgr,
        where=resized_alpha[..., None] > (0.5 / 255.0))
    return np.clip(np.rint(resized_bgr), 0, 255).astype(np.uint8), resized_alpha


def _layout_gemstone(bgr, alpha, width_mm, height_mm):
    """Scale the gemstone and retain horizontal canvas padding only."""
    image = np.ascontiguousarray(bgr)
    matte = np.ascontiguousarray(alpha, dtype=np.float32)
    pixel_height, pixel_width = matte.shape
    physical_is_wide = width_mm > height_mm
    physical_is_tall = height_mm > width_mm
    pixel_is_wide = pixel_width >= pixel_height
    rotate = ((physical_is_wide and not pixel_is_wide) or
              (physical_is_tall and pixel_is_wide))
    if rotate:
        image = cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
        matte = cv2.rotate(matte, cv2.ROTATE_90_CLOCKWISE)

    pixels_per_mm = GEM_CANVAS_PX / GEM_CANVAS_MM
    target_width = max(1, int(round(width_mm * pixels_per_mm)))
    resized_bgr, resized_alpha = _resize_gem_content(
        image, matte, target_width)
    target_height = resized_alpha.shape[0]
    if target_width > GEM_CANVAS_PX or target_height > GEM_CANVAS_PX:
        raise HTTPException(
            422, "gemstone dimensions and aspect ratio exceed the canvas")

    canvas_bgr = np.zeros((target_height, GEM_CANVAS_PX, 3), np.uint8)
    canvas_alpha = np.zeros((target_height, GEM_CANVAS_PX), np.float32)
    x_offset = (GEM_CANVAS_PX - target_width) // 2
    canvas_bgr[:, x_offset:x_offset + target_width] = resized_bgr
    canvas_alpha[:, x_offset:x_offset + target_width] = resized_alpha
    metadata = {
        "width_mm": width_mm,
        "height_mm": height_mm,
        "canvas_px": GEM_CANVAS_PX,
        "canvas_mm": GEM_CANVAS_MM,
        "rotated": rotate,
        "output_width": GEM_CANVAS_PX,
        "output_height": target_height,
    }
    return canvas_bgr, canvas_alpha, metadata


def _gem_layout_headers(metadata):
    return {
        "X-Gem-Width-Mm": f"{metadata['width_mm']:g}",
        "X-Gem-Height-Mm": f"{metadata['height_mm']:g}",
        "X-Gem-Canvas-Px": str(metadata["canvas_px"]),
        "X-Gem-Canvas-Mm": f"{metadata['canvas_mm']:g}",
        "X-Gem-Rotated": str(metadata["rotated"]).lower(),
        "X-Output-Width": str(metadata["output_width"]),
        "X-Output-Height": str(metadata["output_height"]),
    }


def _read_image(data):
    encoded = np.frombuffer(data, np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise HTTPException(400, "could not decode image")
    has_alpha = image.ndim == 3 and image.shape[2] in (2, 4)
    if not has_alpha:
        # Keep the old opaque-image decode path, including EXIF orientation.
        bgr = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if bgr is None:
            raise HTTPException(400, "could not decode image")
        return np.ascontiguousarray(bgr), None

    if image.dtype == np.uint16:
        image = np.rint(image.astype(np.float32) / 257.0).astype(np.uint8)
    elif image.dtype != np.uint8:
        image = np.clip(image, 0, 255).astype(np.uint8)

    source_alpha = None
    if image.shape[2] == 2:
        bgr = cv2.cvtColor(image[..., 0], cv2.COLOR_GRAY2BGR)
        source_alpha = image[..., 1].astype(np.float32) / 255.0
    elif image.shape[2] == 4:
        bgr = image[..., :3]
        source_alpha = image[..., 3].astype(np.float32) / 255.0
    else:
        raise HTTPException(400, "unsupported image channels")
    return np.ascontiguousarray(bgr), source_alpha


def _read(data):
    return _read_image(data)[0]


@app.get("/health")
def health():
    return {"ok": True, "model": os.path.basename(MODEL), "size": SIZE,
            "providers": _sess.get_providers(),
            "provider_required": PROVIDER_OVERRIDE,
            "checkpoint_sha256": _model_meta.get("checkpoint_sha256"),
            "ownership_mode": OWNERSHIP_MODE,
            "ownership_refiner": (os.path.basename(OWNERSHIP_REFINER_MODEL)
                                    if OWNERSHIP_REFINER_MODEL else None),
            "ownership_refiner_architecture": _ownership_refiner_architecture,
            "ownership_refiner_threshold": OWNERSHIP_REFINER_THR,
            "ownership_refiner_class_thresholds":
                OWNERSHIP_REFINER_CLASS_THRESHOLDS,
            "layer_refiner_resize": LAYER_REFINER_RESIZE,
            "min_refiner_action_component": MIN_REFINER_ACTION_COMPONENT,
            "matte_threshold": MATTE_THR, "back_threshold": BACK_THR,
            "edge_trim": EDGE_TRIM, "antialias": ANTIALIAS,
            "edge_feather": EDGE_FEATHER,
            "edge_texture_tol": EDGE_TEXTURE_TOL,
            "min_alpha_component": MIN_ALPHA_COMPONENT,
            "source_refine_radius": SOURCE_REFINE_RADIUS,
            "source_refine_iterations": SOURCE_REFINE_ITERATIONS,
            "opening_smooth_window": OPENING_SMOOTH_WINDOW,
            "opening_smooth_depth": OPENING_SMOOTH_DEPTH,
            "source_edge_radius": SOURCE_EDGE_RADIUS,
            "source_edge_color_tol": SOURCE_EDGE_COLOR_TOL,
            "back_expand": BACK_EXPAND,
            "low_res_back_expand": LOW_RES_BACK_EXPAND,
            "low_res_min_front_component": LOW_RES_MIN_FRONT_COMPONENT,
            "low_res_min_back_component": LOW_RES_MIN_BACK_COMPONENT,
            "low_res_conservative_matte": True,
            "low_res_ownership_resize": "majority",
            "back_smooth_window": BACK_SMOOTH_WINDOW,
            "back_smooth_depth": BACK_SMOOTH_DEPTH,
            "back_bridge_thickness": BACK_BRIDGE_THICKNESS,
            "min_back_component": MIN_BACK_COMPONENT,
            "gem_veto_tol": GEM_VETO_TOL,
            "gem_edge_erode": GEM_EDGE_ERODE,
            "gem_contour_epsilon": GEM_CONTOUR_EPSILON,
            "gem_contour_supersample": GEM_CONTOUR_SUPERSAMPLE,
            "gem_canvas_px": GEM_CANVAS_PX,
            "gem_canvas_mm": GEM_CANVAS_MM,
            "gem_max_dimension_mm": GEM_MAX_DIMENSION_MM,
            "gem_default_width_mm": GEM_DEFAULT_WIDTH_MM,
            "gem_default_height_mm": GEM_DEFAULT_HEIGHT_MM,
            "recommended_input_size": RECOMMENDED_INPUT,
            "processing_min_size": PROCESSING_MIN_SIZE,
            "processing_max_size": PROCESSING_MAX_SIZE,
            "enclosed_veto_tol": ENCLOSED_VETO_TOL,
            "enclosed_texture_tol": ENCLOSED_TEXTURE_TOL}


@app.post("/segment")
async def segment_json(file: UploadFile = File(...), compact: bool = False):
    """Ring layers plus diagnostics.

    The default response preserves the original three-PNG API.  ``compact``
    sends the full-color PNG once and represents front/back ownership as small
    alpha masks, avoiding two redundant copies of the ring's RGB pixels.
    """
    t0 = time.perf_counter()
    bgr = _read(await file.read())
    a, f, b, fg = segment(bgr)
    ring_px = int((a > MATTE_THR).sum())
    back_px = int((b > BACK_THR).sum())
    # Back fraction outside the observed range is the useful review signal:
    # the training set sits at 0.02-0.33, median 0.195.
    frac = back_px / max(ring_px, 1)
    height, width = bgr.shape[:2]
    processing_height, processing_width = _ring_processing_shape(bgr.shape)
    cropped_fg, (cropped_a, cropped_f, cropped_b), crop = _tight_crop(
        fg, (a, f, b))
    payload = {
        "ring_px": ring_px, "back_px": back_px,
        "back_fraction": round(frac, 4),
        "needs_review": bool(frac < 0.02 or frac > 0.40),
        "source_width": width,
        "source_height": height,
        "crop": crop,
        "processing_width": processing_width,
        "processing_height": processing_height,
        "supersampled": bool(
            (processing_height, processing_width) != (height, width)),
        "low_resolution_input": bool(min(width, height) < RECOMMENDED_INPUT),
    }
    payload["full"] = base64.b64encode(
        _png(cropped_fg, cropped_a)).decode()
    if compact:
        payload["front_mask"] = base64.b64encode(
            _ownership_png(cropped_a, cropped_f)).decode()
        payload["back_mask"] = base64.b64encode(
            _ownership_png(cropped_a, cropped_b)).decode()
        payload["transport"] = "compact-alpha-masks"
    else:
        payload["front"] = base64.b64encode(
            _png(cropped_fg, cropped_f)).decode()
        payload["back"] = base64.b64encode(
            _png(cropped_fg, cropped_b)).decode()
        payload["transport"] = "three-png"
    payload["ms"] = round(1000 * (time.perf_counter() - t0), 1)
    return JSONResponse(payload)


@app.post("/segment/{layer}")
async def segment_layer(layer: str, file: UploadFile = File(...)):
    """Single layer as a raw PNG - simplest thing for a frontend to consume."""
    if layer not in ("full", "front", "back"):
        raise HTTPException(404, "layer must be full, front or back")
    bgr = _read(await file.read())
    a, f, b, fg = segment(bgr)
    cropped_fg, cropped_masks, crop = _tight_crop(fg, (a, f, b))
    selected = {"full": cropped_masks[0], "front": cropped_masks[1],
                "back": cropped_masks[2]}[layer]
    return Response(_png(cropped_fg, selected), media_type="image/png",
                    headers=_crop_headers(bgr.shape, crop))


@app.post("/segment-gem")
async def segment_gemstone(file: UploadFile = File(...),
                           width: float | None = Form(None),
                           height: float | None = Form(None)):
    """Segment and place one gemstone on the physical-scale VTO canvas."""
    width_mm, height_mm = _gem_dimensions(width, height)
    bgr, source_alpha = _read_image(await file.read())
    alpha, _, _, foreground = segment_gem(bgr, source_alpha=source_alpha)
    cropped_fg, (cropped_alpha,), crop = _tight_crop(
        foreground, (alpha,))
    output_bgr, output_alpha, layout = _layout_gemstone(
        cropped_fg, cropped_alpha, width_mm, height_mm)
    headers = _crop_headers(bgr.shape, crop)
    headers.update(_gem_layout_headers(layout))
    return Response(_png(output_bgr, output_alpha),
                    media_type="image/png", headers=headers)
