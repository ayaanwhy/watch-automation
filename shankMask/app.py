import json
import os
import re
import time
import uuid
import base64

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import config
import settings as settings_store
from detectors import DetectorError, get_detector
from pipeline import anchors as anchors_mod
from pipeline import assets as assets_mod
from pipeline import matting as matting_mod
from pipeline import refine as refine_mod
from pipeline import segmentation as segmentation_mod
from pipeline import wrap as wrap_mod

config.ensure_dirs()

if os.environ.get("SEED_SAMPLES", "").lower() in ("1", "true", "yes", "on"):
    try:
        import seed as _seed

        _seed.run()
    except Exception:
        pass

app = FastAPI(title="VTO Preprocessing", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/assets", StaticFiles(directory=str(config.STORAGE_DIR)), name="assets")

_removers = {}
_segmenters = {}


def remover(name: str = None):
    """Return a cached background-matting backend by name (default config.BG_MODEL)."""
    name = (name or config.BG_MODEL or "birefnet").strip().lower()
    if name not in _removers:
        if name in ("", "birefnet"):
            model_path = config.BIREFNET_MODEL
            if not model_path or not os.path.exists(model_path):
                raise HTTPException(
                    status_code=503,
                    detail="Background model is not available. Set BIREFNET_MODEL.",
                )
        try:
            _removers[name] = matting_mod.build(name, config)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Unknown background model '{name}'.")
        except ImportError as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Background model '{name}' is not installed ({exc}).",
            )
    return _removers[name]


def segmenter(name: str = None):
    """Return a cached optional segmentation backend."""
    name = (name or config.SEG_MODEL or "sam_hq").strip().lower()
    if name in ("", "none", "off"):
        return None
    if name not in _segmenters:
        try:
            _segmenters[name] = segmentation_mod.build(name, config)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Unknown segmentation model '{name}'.")
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Segmentation model '{name}' is not available ({exc}).",
            )
    return _segmenters[name]


def _slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return value or uuid.uuid4().hex[:8]


def _decode(raw: bytes) -> np.ndarray:
    arr = np.frombuffer(raw, np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="Could not decode image.")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def _limit_product_image(rgb: np.ndarray) -> np.ndarray:
    max_dim = max(256, int(getattr(config, "MAX_PRODUCT_DIM", 2400)))
    h, w = rgb.shape[:2]
    m = max(h, w)
    if m <= max_dim:
        return rgb
    scale = max_dim / float(m)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    return cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_AREA)


def _asset_url(rel: str) -> str:
    return f"{config.PUBLIC_ASSETS_URL}/assets/{rel}"


def _bust(url):
    """Append the asset file's mtime as ?v= so edited assets miss the browser
    cache while unchanged assets stay cacheable. No-ops on missing/external URLs."""
    if not isinstance(url, str) or "/assets/" not in url:
        return url
    base = url.split("?", 1)[0]
    rel = base.split("/assets/", 1)[1]
    fpath = config.STORAGE_DIR / rel
    try:
        ver = int(fpath.stat().st_mtime)
    except OSError:
        return url
    return f"{base}?v={ver}"


def _bust_info(info: dict) -> dict:
    for key in ("imageUrl", "maskUrl", "thumbUrl"):
        if info.get(key):
            info[key] = _bust(info[key])
    wrap = info.get("wrapOcclusion")
    if isinstance(wrap, dict):
        for key in ("maskUrl", "frontMaskUrl", "frontImageUrl", "fullImageUrl"):
            if wrap.get(key):
                wrap[key] = _bust(wrap[key])
    return info


def _float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# Normalize a free-text category to the render kind the on-model SDK understands.
_KIND_MAP = {
    "bracelet": "bracelet", "bangle": "bracelet", "cuff": "bracelet",
    "watch": "watch",
    "ring": "ring",
    "necklace": "necklace", "pendant": "necklace", "chain": "necklace",
    "earring": "earring", "earrings": "earring", "stud": "earring", "hoop": "earring",
}


def _kind_for(category: str, body_type: str) -> str:
    key = (category or "").strip().lower()
    if key in _KIND_MAP:
        return _KIND_MAP[key]
    return {"wrist": "bracelet", "finger": "ring", "neck": "necklace", "ear": "earring"}.get(body_type, "bracelet")


# ─── Products ────────────────────────────────────────────────
def _product_info_path(sku: str):
    return config.PRODUCTS_DIR / f"{sku}-info.json"


def _read_product(sku: str):
    path = _product_info_path(sku)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _write_product(info: dict):
    _product_info_path(info["sku"]).write_text(json.dumps(info))


@app.post("/api/v1/products")
async def create_product(
    image: UploadFile,
    name: str = Form(...),
    category: str = Form(""),
    bodyType: str = Form("wrist"),
    widthMm: str = Form(None),
    heightMm: str = Form(None),
    sku: str = Form(None),
    bgModel: str = Form(None),
    bgProfile: str = Form(None),
):
    raw = await image.read()
    rgb = _limit_product_image(_decode(raw))
    bg_model = (bgModel or config.BG_MODEL or "birefnet").strip().lower()
    bg_profile = (bgProfile or "standard").strip().lower()
    backend = remover(bg_model)
    # Sharp/segmented studio cleanup should use the raw model matte; standard
    # uploads may use backend-specific matte shaping (for example BEN2 edge lift).
    sharp_profiles = (
        "sharp", "studio-sharp", "sharp-preserve", "reflection-cleanup",
        "studio-white", "segmented-studio", "sam-hq-studio",
    )
    if bg_profile in sharp_profiles and hasattr(backend, "raw_matte"):
        matte = backend.raw_matte(rgb)
    else:
        matte = backend.matte(rgb)

    seg_meta = None
    # Clean the matte and prepare the cutout/mask.
    if bg_profile in ("sharp", "studio-sharp", "sharp-preserve"):
        alpha, decon_rgb, mask = refine_mod.refine_sharp(matte, rgb, threshold=127, remove_reflection=False)
    elif bg_profile in ("segmented-studio", "sam-hq-studio"):
        try:
            seg = segmenter(config.SEG_MODEL)
            prompts = segmentation_mod.studio_prompts(rgb, matte)
            candidates = seg.segment(rgb, prompts) if seg else []
            chosen = segmentation_mod.choose_mask(candidates, rgb, matte, prompts)
            if chosen is None:
                raise RuntimeError("no segmentation mask selected")
            alpha, decon_rgb, mask = refine_mod.refine_segmented_studio(matte, rgb, chosen.mask)
            seg_meta = {"model": config.SEG_MODEL, "used": True, "score": round(chosen.score, 4), "details": chosen.meta, "prompts": prompts.get("meta", {})}
        except Exception as exc:
            alpha, decon_rgb, mask = refine_mod.refine_studio_white(matte, rgb)
            seg_meta = {"model": config.SEG_MODEL, "used": False, "fallback": "studio-white", "error": str(exc)}
    elif bg_profile == "studio-white":
        alpha, decon_rgb, mask = refine_mod.refine_studio_white(matte, rgb)
    elif bg_profile in ("reflection-cleanup", "sharp-reflection"):
        alpha, decon_rgb, mask = refine_mod.refine_sharp(matte, rgb, threshold=150, remove_reflection=True)
    else:
        alpha, decon_rgb = refine_mod.refine_matte(matte, rgb)
        mask = refine_mod.clean_stencil(matte)

    width_mm = _float(widthMm)
    height_mm = _float(heightMm)
    geom = anchors_mod.compute_anchors(mask, width_mm)

    sku = _slug(sku or name)
    if _read_product(sku):
        sku = f"{sku}-{uuid.uuid4().hex[:6]}"

    thumb = assets_mod.square_thumb(decon_rgb)
    assets_mod.write_rgb(config.PRODUCTS_DIR / f"{sku}-source.png", rgb)
    assets_mod.write_cutout(config.PRODUCTS_DIR / f"{sku}-image.png", decon_rgb, alpha)
    assets_mod.write_mask(config.PRODUCTS_DIR / f"{sku}-mask.png", mask)
    assets_mod.write_rgb(config.PRODUCTS_DIR / f"{sku}-thumb.png", thumb)

    info = {
        "sku": sku,
        "name": name,
        "category": category,
        "kind": _kind_for(category, bodyType),
        "bodyType": bodyType,
        "widthMm": width_mm,
        "heightMm": height_mm,
        "sizeMm": (height_mm if bodyType == "ear" else width_mm),
        "sourceUrl": _asset_url(f"products/_processed/{sku}-source.png"),
        "imageUrl": _asset_url(f"products/_processed/{sku}-image.png"),
        "maskUrl": _asset_url(f"products/_processed/{sku}-mask.png"),
        "thumbUrl": _asset_url(f"products/_processed/{sku}-thumb.png"),
        "imgWidth": geom["imgWidth"],
        "imgHeight": geom["imgHeight"],
        "imageAspectRatio": (geom["imgHeight"] / geom["imgWidth"]) if geom["imgWidth"] else 1,
        "bgModel": bg_model,
        "bgProfile": bg_profile,
        "segmentation": seg_meta,
        "anchor": geom["anchor"],
        "bbox": geom["bbox"],
        "bboxWidthPx": geom["bboxWidthPx"],
        "pixelsPerMm": geom["pixelsPerMm"],
        "status": "needs_review",
        "maskQuality": _mask_quality(rgb, alpha, seg_meta),
        "createdAt": time.time(),
    }
    # Bracelets: seed band anchors + an auto "behind the wrist" wrap mask so the
    # editor opens pre-marked and the on-model view occludes by default.
    if info["kind"] == "bracelet" and geom.get("bbox"):
        bb = geom["bbox"]
        cy = bb["y"] + bb["h"] / 2
        info["pointA"] = {"x": bb["x"], "y": cy}
        info["pointB"] = {"x": bb["x"] + bb["w"], "y": cy}
        info["hotSpot"] = {"x": bb["x"] + bb["w"] / 2, "y": cy}
        split_y = 0.5
        wrap_mask, detected = wrap_mod.generate_wrap_mask(alpha, split_y)
        assets_mod.write_wrap_mask(config.PRODUCTS_DIR / f"{sku}-wrap-mask.png", wrap_mask)
        info["wrapOcclusion"] = {
            "type": "wrist_loop",
            "version": 3,
            "mode": "product_bgmask_skin_over",
            "frontAnchor": "pointA-pointB",
            "maskSource": "auto" if detected else "auto-fallback",
            "splitY": split_y,
            "maskUrl": _asset_url(f"products/_processed/{sku}-wrap-mask.png"),
        }
    _write_product(info)
    return info


@app.get("/api/v1/products")
async def list_products(bodyType: str = None, status: str = None):
    items = []
    for path in sorted(config.PRODUCTS_DIR.glob("*-info.json")):
        try:
            info = json.loads(path.read_text())
        except Exception:
            continue
        if bodyType and info.get("bodyType") != bodyType:
            continue
        if status and info.get("status") != status:
            continue
        items.append(info)
    return {"products": items}


@app.get("/api/v1/products/{sku}")
async def get_product(sku: str):
    info = _read_product(sku)
    if not info:
        raise HTTPException(status_code=404, detail="Product not found.")
    return info


@app.patch("/api/v1/products/{sku}")
async def update_product(sku: str, payload: dict):
    info = _read_product(sku)
    if not info:
        raise HTTPException(status_code=404, detail="Product not found.")
    # Keep a stable bbox width so that editing the real size recomputes the
    # pixels-per-mm scale (imported products may not carry bboxWidthPx).
    if not info.get("bboxWidthPx"):
        old_w = _float(info.get("widthMm"))
        old_ppm = _float(info.get("pixelsPerMm"))
        if old_w and old_ppm:
            info["bboxWidthPx"] = old_ppm * old_w
    for key in ("name", "category", "bodyType", "status"):
        if key in payload and payload[key] is not None:
            info[key] = payload[key]
    for key in ("widthMm", "heightMm"):
        if key in payload:
            info[key] = _float(payload[key])
    # sizeMm mirrors the size-driving dimension (height for ear, width otherwise).
    if info.get("bodyType") == "ear":
        if info.get("heightMm"):
            info["sizeMm"] = info["heightMm"]
    elif info.get("widthMm"):
        info["sizeMm"] = info["widthMm"]
    if "anchor" in payload and isinstance(payload["anchor"], dict):
        ax = _float(payload["anchor"].get("x"))
        ay = _float(payload["anchor"].get("y"))
        if ax is not None and ay is not None:
            info["anchor"] = {"x": ax, "y": ay}
    if info.get("widthMm") and info.get("bboxWidthPx"):
        info["pixelsPerMm"] = info["bboxWidthPx"] / float(info["widthMm"])
    _write_product(info)
    return info


@app.delete("/api/v1/products/{sku}")
async def delete_product(sku: str):
    info = _read_product(sku)
    if not info:
        raise HTTPException(status_code=404, detail="Product not found.")
    roles = ("info.json", "image", "source", "mask", "thumb", "wrap-mask", "front", "front-mask")
    for role in roles:
        if role.endswith(".json"):
            candidates = [config.PRODUCTS_DIR / f"{sku}-{role}"]
        else:
            candidates = [config.PRODUCTS_DIR / f"{sku}-{role}.{ext}" for ext in ("png", "webp", "jpg", "jpeg")]
        for path in candidates:
            if path.exists():
                try:
                    path.unlink()
                except OSError:
                    pass
    return {"ok": True}


def _find_asset(sku: str, role: str):
    for ext in ("png", "webp", "jpg", "jpeg"):
        path = config.PRODUCTS_DIR / f"{sku}-{role}.{ext}"
        if path.exists():
            return path
    return None


def _read_rgb_any(path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise HTTPException(status_code=400, detail="Could not read cutout image.")
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    if img.shape[2] == 4:
        return cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2RGB)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def _mask_quality(image_rgb: np.ndarray, alpha: np.ndarray, seg_meta: dict = None) -> dict:
    a = (alpha > 8).astype(np.uint8) * 255
    area = max(1, int((a > 0).sum()))
    if a.max() == 0:
        return {"needsReview": True, "backgroundResidueRisk": 1.0, "productLossRisk": 1.0, "notes": ["empty mask"]}

    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edge = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    edge = cv2.GaussianBlur(edge, (0, 0), 1.0)
    dist_outer = cv2.distanceTransform((a > 0).astype(np.uint8), cv2.DIST_L2, 5)
    pale_edge = ((a > 0) & (dist_outer < 24) & (sat < 38) & (val > 205) & (edge < 10))
    residue = min(1.0, float(pale_edge.sum()) / max(1.0, area * 0.018))

    inv = cv2.bitwise_not(a)
    ff = inv.copy()
    h, w = a.shape
    flood = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, flood, (0, 0), 0)
    num, labels, stats, _ = cv2.connectedComponentsWithStats(ff, 8)
    small_hole_area = 0
    small_holes = 0
    for i in range(1, num):
        ar = int(stats[i, cv2.CC_STAT_AREA])
        ww = int(stats[i, cv2.CC_STAT_WIDTH])
        hh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if 12 <= ar <= max(900, int(area * 0.006)) and not (ww > w * 0.05 and hh > h * 0.05):
            small_hole_area += ar
            small_holes += 1
    hole_risk = min(1.0, small_hole_area / max(1.0, area * 0.012))

    seg_risk = 0.0
    if seg_meta:
        if not seg_meta.get("used"):
            seg_risk = 0.5
        else:
            details = seg_meta.get("details") or {}
            seg_risk = max(0.0, min(1.0, float(details.get("reflectionRatio", 0)) * 3.0))

    needs = residue > 0.35 or hole_risk > 0.35 or seg_risk > 0.45
    notes = []
    if residue > 0.35:
        notes.append("possible pale edge/background residue")
    if hole_risk > 0.35:
        notes.append("possible product highlight holes")
    if seg_risk > 0.45:
        notes.append("segmentation/reflection uncertainty")
    return {
        "needsReview": bool(needs),
        "backgroundResidueRisk": round(float(residue), 3),
        "productLossRisk": round(float(hole_risk), 3),
        "segmentationRisk": round(float(seg_risk), 3),
        "smallHoles": int(small_holes),
        "notes": notes,
    }


def _apply_geometry(info: dict, mask: np.ndarray) -> None:
    geom = anchors_mod.compute_anchors(mask, info.get("widthMm"))
    info["anchor"] = geom["anchor"]
    info["bbox"] = geom["bbox"]
    info["bboxWidthPx"] = geom["bboxWidthPx"]
    info["pixelsPerMm"] = geom["pixelsPerMm"]
    info["imgWidth"] = geom["imgWidth"]
    info["imgHeight"] = geom["imgHeight"]
    info["imageAspectRatio"] = (geom["imgHeight"] / geom["imgWidth"]) if geom["imgWidth"] else 1


@app.post("/api/v1/products/{sku}/approve")
async def approve_product(sku: str):
    info = _read_product(sku)
    if not info:
        raise HTTPException(status_code=404, detail="Product not found.")
    info["status"] = "approved"
    _write_product(info)
    return info


@app.post("/api/v1/products/{sku}/cutout")
async def edit_cutout(sku: str, mask: UploadFile):
    info = _read_product(sku)
    if not info:
        raise HTTPException(status_code=404, detail="Product not found.")
    src = _find_asset(sku, "source") or _find_asset(sku, "image")
    if not src:
        raise HTTPException(status_code=404, detail="Cutout image missing.")
    rgb = _read_rgb_any(src)
    h, w = rgb.shape[:2]

    raw = await mask.read()
    keep = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
    if keep is None:
        raise HTTPException(status_code=400, detail="Could not decode mask.")
    if (keep.shape[1], keep.shape[0]) != (w, h):
        keep = cv2.resize(keep, (w, h), interpolation=cv2.INTER_LINEAR)

    alpha = keep
    binary = np.where(alpha > 127, 255, 0).astype(np.uint8)
    fa = (alpha.astype(np.float32) / 255.0)[:, :, None]
    composed = (rgb.astype(np.float32) * fa + 255.0 * (1.0 - fa)).astype(np.uint8)

    assets_mod.write_cutout(config.PRODUCTS_DIR / f"{sku}-image.png", rgb, alpha)
    assets_mod.write_mask(config.PRODUCTS_DIR / f"{sku}-mask.png", binary)
    assets_mod.write_rgb(
        config.PRODUCTS_DIR / f"{sku}-thumb.png", assets_mod.square_thumb(composed)
    )
    for role in ("image", "mask", "thumb"):
        for ext in ("webp", "jpg", "jpeg"):
            stale = config.PRODUCTS_DIR / f"{sku}-{role}.{ext}"
            if stale.exists():
                stale.unlink()

    if _find_asset(sku, "source"):
        info["sourceUrl"] = _asset_url(f"products/_processed/{sku}-source.png")
    info["imageUrl"] = _asset_url(f"products/_processed/{sku}-image.png")
    info["maskUrl"] = _asset_url(f"products/_processed/{sku}-mask.png")
    info["thumbUrl"] = _asset_url(f"products/_processed/{sku}-thumb.png")
    _apply_geometry(info, binary)
    info["maskQuality"] = _mask_quality(rgb, alpha, info.get("segmentation"))
    _write_product(info)
    return info


@app.post("/api/v1/products/{sku}/sam-edit")
async def sam_edit_cutout(
    sku: str,
    mask: UploadFile,
    x: str = Form(...),
    y: str = Form(...),
    action: str = Form("remove"),
):
    """SAM-assisted mask edit. The browser sends the current keep mask and one
    click. We return an updated keep mask; normal /cutout save persists it."""
    info = _read_product(sku)
    if not info:
        raise HTTPException(status_code=404, detail="Product not found.")
    src = _find_asset(sku, "source") or _find_asset(sku, "image")
    if not src:
        raise HTTPException(status_code=404, detail="Source image missing.")
    rgb = _read_rgb_any(src)

    raw = await mask.read()
    keep = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
    if keep is None:
        raise HTTPException(status_code=400, detail="Could not decode mask.")
    h, w = keep.shape[:2]
    if (rgb.shape[1], rgb.shape[0]) != (w, h):
        rgb = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA)

    try:
        px = float(x)
        py = float(y)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid click coordinates.")
    px = max(0.0, min(float(w - 1), px))
    py = max(0.0, min(float(h - 1), py))
    act = (action or "remove").strip().lower()

    seg = segmenter(config.SEG_MODEL)
    if not seg:
        raise HTTPException(status_code=503, detail="Segmentation model is disabled.")

    # Local click-driven prompt. Remove uses a small local box so SAM cannot
    # accidentally select the entire bracelet; restore may use the product bbox.
    ys, xs = np.where(keep > 8)
    box = None
    if act == "remove":
        radius = max(64, int(round(max(w, h) * 0.085)))
        box = [max(0, int(round(px)) - radius), max(0, int(round(py)) - radius),
               min(w - 1, int(round(px)) + radius), min(h - 1, int(round(py)) + radius)]
    elif len(xs):
        pad = max(16, int(round(max(w, h) * 0.03)))
        box = [max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
               min(w - 1, int(xs.max()) + pad), min(h - 1, int(ys.max()) + pad)]
    prompts = {"points": [(px, py)], "labels": [1], "box": box, "meta": {"mode": "sam-edit", "action": act}}
    candidates = seg.segment(rgb, prompts)
    if not candidates:
        raise HTTPException(status_code=503, detail="SAM did not return a mask.")

    best = None
    click_i = int(round(py)) * w + int(round(px))
    keep_area = max(1, int((keep > 8).sum()))
    max_remove_area = max(800, int(keep_area * 0.08))
    for cand in candidates:
        m = cand.mask > 0
        if not m.ravel()[click_i]:
            continue
        area = int(m.sum())
        source = cand.source_score if cand.source_score is not None else 0.0
        if act == "remove":
            if area > max_remove_area:
                continue
            score = float(source) - (area / max(1.0, max_remove_area)) * 0.35
        else:
            overlap = float((m & (keep > 8)).sum()) / max(1, area)
            score = float(source) + 0.25 * overlap - 0.15 * abs(area / keep_area - 0.2)
        if best is None or score > best[0]:
            best = (score, cand, area)
    if best is None:
        if act == "remove":
            smallest = min(candidates, key=lambda c: int((c.mask > 0).sum()))
            area = int((smallest.mask > 0).sum())
            if area > max_remove_area:
                raise HTTPException(status_code=409, detail="SAM selected too much product. Use brush erase or click a smaller leftover area.")
            cand = smallest
        else:
            cand = min(candidates, key=lambda c: int((c.mask > 0).sum()))
    else:
        cand = best[1]

    region = (cand.mask > 0).astype(np.uint8) * 255
    cur = np.where(keep > 8, 255, 0).astype(np.uint8)
    if act == "restore":
        updated = cv2.bitwise_or(cur, region)
    else:
        updated = cur.copy()
        updated[region > 0] = 0
    ok, buf = cv2.imencode(".png", updated)
    if not ok:
        raise HTTPException(status_code=500, detail="Could not encode mask.")
    return {
        "mask": "data:image/png;base64," + base64.b64encode(buf).decode(),
        "action": act,
        "regionPixels": int((region > 0).sum()),
        "coverage": round(float((updated > 0).mean()), 4),
    }


@app.post("/api/v1/products/{sku}/wrap-mask")
async def edit_wrap_mask(sku: str, mask: UploadFile):
    info = _read_product(sku)
    if not info:
        raise HTTPException(status_code=404, detail="Product not found.")
    raw = await mask.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty mask.")
    (config.PRODUCTS_DIR / f"{sku}-wrap-mask.png").write_bytes(raw)
    prev = info.get("wrapOcclusion") or {}
    try:
        version = max(int(prev.get("version") or 0), 3)
    except (TypeError, ValueError):
        version = 3
    info["wrapOcclusion"] = {
        "maskUrl": _asset_url(f"products/_processed/{sku}-wrap-mask.png"),
        "version": version,
        "maskSource": "manual",
    }
    info["kind"] = info.get("kind") or "bracelet"
    _write_product(info)
    return info


# ─── Models ──────────────────────────────────────────────────
def _model_dir(model_id: str):
    return config.MODELS_DIR / model_id


def _read_model(model_id: str):
    path = _model_dir(model_id) / "info.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _write_model(info: dict):
    target = _model_dir(info["id"])
    target.mkdir(parents=True, exist_ok=True)
    (target / "info.json").write_text(json.dumps(info))


@app.post("/api/v1/models")
async def create_model(
    image: UploadFile,
    bodyType: str = Form("wrist"),
    toneId: str = Form(None),
    label: str = Form(None),
    autoDetect: str = Form("true"),
):
    raw = await image.read()
    rgb = _decode(raw)
    model_id = f"{bodyType}-{uuid.uuid4().hex[:8]}"
    target = _model_dir(model_id)
    target.mkdir(parents=True, exist_ok=True)

    assets_mod.write_rgb(target / "image.png", rgb)
    assets_mod.write_rgb(target / "thumb.png", assets_mod.square_thumb(rgb))

    coords = None
    detect_error = None
    if str(autoDetect).lower() in ("1", "true", "yes", "on"):
        try:
            coords = get_detector().detect_single(raw, image.filename, bodyType)
        except DetectorError as exc:
            detect_error = exc.code
        except Exception:
            detect_error = "detector_failed"

    info = {
        "id": model_id,
        "bodyType": bodyType,
        "label": label or model_id,
        "toneId": toneId,
        "imageUrl": _asset_url(f"models/{model_id}/image.png"),
        "thumbUrl": _asset_url(f"models/{model_id}/thumb.png"),
        "imgWidth": int(rgb.shape[1]),
        "imgHeight": int(rgb.shape[0]),
        "coords": coords,
        "detectError": detect_error,
        "createdAt": time.time(),
    }
    _write_model(info)
    return info


@app.get("/api/v1/models")
async def list_models(bodyType: str = None):
    items = []
    if config.MODELS_DIR.exists():
        for path in sorted(config.MODELS_DIR.glob("*/info.json")):
            try:
                info = json.loads(path.read_text())
            except Exception:
                continue
            if bodyType and info.get("bodyType") != bodyType:
                continue
            items.append(info)
    return {"models": items}


@app.put("/api/v1/models/{model_id}/coordinates")
async def set_model_coordinates(model_id: str, payload: dict):
    info = _read_model(model_id)
    if not info:
        raise HTTPException(status_code=404, detail="Model not found.")
    info["coords"] = payload.get("coords", payload)
    info["detectError"] = None
    _write_model(info)
    return info


@app.post("/api/v1/models/{model_id}/detect")
async def detect_model_coordinates(model_id: str):
    info = _read_model(model_id)
    if not info:
        raise HTTPException(status_code=404, detail="Model not found.")
    image_path = _model_dir(model_id) / "image.png"
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Model image missing.")
    try:
        coords = get_detector().detect_single(
            image_path.read_bytes(), "image.png", info.get("bodyType", "wrist")
        )
    except DetectorError as exc:
        raise HTTPException(status_code=502, detail={"code": exc.code, "message": exc.message})
    info["coords"] = coords
    info["detectError"] = None
    _write_model(info)
    return info


@app.delete("/api/v1/models/{model_id}")
async def delete_model(model_id: str):
    target = _model_dir(model_id)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Model not found.")
    for child in target.glob("*"):
        child.unlink()
    target.rmdir()
    return {"ok": True}


# ─── Settings ────────────────────────────────────────────────
@app.get("/api/v1/settings")
async def get_settings():
    return settings_store.public_view()


@app.put("/api/v1/settings")
async def put_settings(payload: dict):
    settings_store.save(
        detector_url=payload.get("detectorUrl"),
        detector_token=payload.get("detectorToken"),
    )
    return settings_store.public_view()


@app.post("/api/v1/settings/test")
async def test_settings():
    try:
        status, body = get_detector().health()
        return {"ok": status < 400, "status": status, "body": body}
    except DetectorError as exc:
        return JSONResponse(
            status_code=200,
            content={"ok": False, "code": exc.code, "message": exc.message},
        )
    except Exception as exc:
        return JSONResponse(
            status_code=200,
            content={"ok": False, "code": "unreachable", "message": str(exc)[:300]},
        )


# ─── Manifest ────────────────────────────────────────────────
@app.get("/api/v1/prepare")
async def prepare(bodyType: str = "wrist"):
    models = []
    if config.MODELS_DIR.exists():
        for path in sorted(config.MODELS_DIR.glob("*/info.json")):
            try:
                info = json.loads(path.read_text())
            except Exception:
                continue
            if info.get("bodyType") != bodyType:
                continue
            models.append(_bust_info(info))

    products = []
    for path in sorted(config.PRODUCTS_DIR.glob("*-info.json")):
        try:
            info = json.loads(path.read_text())
        except Exception:
            continue
        if info.get("status") != "approved":
            continue
        if info.get("bodyType") != bodyType:
            continue
        products.append(_bust_info(info))

    return {"version": 1, "bodyType": bodyType, "models": models, "products": products}


@app.get("/api/v1/bg-models")
async def bg_models():
    return {"active": config.BG_MODEL, "models": matting_mod.availability()}


@app.get("/api/v1/seg-models")
async def seg_models():
    return {"active": config.SEG_MODEL, "models": segmentation_mod.availability(config)}


@app.post("/api/v1/bg-compare")
async def bg_compare(image: UploadFile, models: str = Form(None), maxDim: str = Form("640")):
    """Run one image through several backends and return preview cutouts side by
    side so a model can be chosen per jewellery category. Each entry has the
    refined cutout (data URL), timing, and foreground coverage."""
    raw = await image.read()
    rgb = _decode(raw)
    try:
        cap = max(128, min(2048, int(maxDim)))
    except (TypeError, ValueError):
        cap = 640
    names = [n.strip().lower() for n in (models or "").split(",") if n.strip()]
    if not names:
        names = [m["name"] for m in matting_mod.availability() if m["available"]]

    h, w = rgb.shape[:2]
    scale = min(1.0, cap / max(h, w))
    prev = cv2.resize(rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else rgb

    results = []
    for name in names:
        entry = {"name": name}
        try:
            backend = remover(name)
            t0 = time.time()
            matte = backend.matte(prev)
            alpha, decon_rgb = refine_mod.refine_matte(matte, prev)
            entry["ms"] = int((time.time() - t0) * 1000)
            entry["coverage"] = round(float((alpha > 127).mean()), 4)
            bgra = np.dstack([cv2.cvtColor(decon_rgb, cv2.COLOR_RGB2BGR), alpha])
            ok, buf = cv2.imencode(".png", bgra)
            if ok:
                entry["cutout"] = "data:image/png;base64," + base64.b64encode(buf).decode()
        except HTTPException as exc:
            entry["error"] = exc.detail
        except Exception as exc:  # noqa: BLE001 - surface model load/run failures
            entry["error"] = str(exc)
        results.append(entry)
    return {"width": prev.shape[1], "height": prev.shape[0], "results": results}


@app.post("/api/v1/seg-compare")
async def seg_compare(image: UploadFile, bgModel: str = Form("ben2"), maxDim: str = Form("1200")):
    """Compare studio-white vs segmented-studio on one image for debugging."""
    raw = await image.read()
    rgb = _decode(raw)
    try:
        cap = max(512, min(2400, int(maxDim)))
    except (TypeError, ValueError):
        cap = 1200
    h, w = rgb.shape[:2]
    scale = min(1.0, cap / max(h, w))
    prev = cv2.resize(rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else rgb

    backend = remover(bgModel)
    matte = backend.raw_matte(prev) if hasattr(backend, "raw_matte") else backend.matte(prev)

    def _pack(name, alpha, decon_rgb, meta=None):
        bgra = np.dstack([cv2.cvtColor(decon_rgb, cv2.COLOR_RGB2BGR), alpha])
        ok, buf = cv2.imencode(".png", bgra)
        return {
            "name": name,
            "coverage": round(float((alpha > 0).mean()), 4),
            "cutout": ("data:image/png;base64," + base64.b64encode(buf).decode()) if ok else None,
            "meta": meta or {},
        }

    results = []
    alpha, decon_rgb, _mask = refine_mod.refine_studio_white(matte, prev)
    results.append(_pack("studio-white", alpha, decon_rgb))

    meta = None
    try:
        seg = segmenter(config.SEG_MODEL)
        prompts = segmentation_mod.studio_prompts(prev, matte)
        candidates = seg.segment(prev, prompts) if seg else []
        chosen = segmentation_mod.choose_mask(candidates, prev, matte, prompts)
        if chosen is None:
            raise RuntimeError("no segmentation mask selected")
        alpha, decon_rgb, _mask = refine_mod.refine_segmented_studio(matte, prev, chosen.mask)
        meta = {"used": True, "score": round(chosen.score, 4), "details": chosen.meta, "prompts": prompts.get("meta", {})}
    except Exception as exc:
        alpha, decon_rgb, _mask = refine_mod.refine_studio_white(matte, prev)
        meta = {"used": False, "fallback": "studio-white", "error": str(exc)}
    results.append(_pack("segmented-studio", alpha, decon_rgb, meta))
    return {"width": prev.shape[1], "height": prev.shape[0], "segmentation": segmentation_mod.availability(config), "results": results}


@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "bodyTypes": config.BODY_TYPES, "detector": config.DETECTOR}


if __name__ == "__main__":
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")
