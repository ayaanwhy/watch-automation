"""Generate sample products and model photos for an out-of-the-box demo.

Run directly:  python seed.py
Or set SEED_SAMPLES=true to seed on backend startup.

Writes synthetic (illustrative) assets into STORAGE_DIR so the console and the
on-model harness have content without a detector or any real photography.
"""
import time

import cv2
import numpy as np

import config
from pipeline import anchors as anchors_mod
from pipeline import assets as assets_mod

MW, MH = 720, 1024

BG = (239, 236, 231)
SKIN = {
    "light": (236, 199, 170),
    "tan": (208, 158, 120),
    "deep": (165, 118, 86),
}
GOLD = (212, 175, 55)
ROSE = (216, 162, 140)
SILVER = (205, 205, 212)
GEM_WHITE = (240, 245, 250)
GEM_BLUE = (120, 170, 220)
DARK = (70, 55, 45)


def _n(x, y, w=MW, h=MH):
    return [round(x / w, 4), round(y / h, 4)]


def _bg(w, h, color):
    c = np.empty((h, w, 3), np.uint8)
    c[:] = color
    return c


def _capsule(img, p0, p1, r, color):
    cv2.line(img, p0, p1, color, r * 2, cv2.LINE_AA)
    cv2.circle(img, p0, r, color, -1, cv2.LINE_AA)
    cv2.circle(img, p1, r, color, -1, cv2.LINE_AA)


def _shade(img, region, delta=18):
    pass


# ─── Model photos (illustrative) ─────────────────────────────
def model_finger(tone):
    img = _bg(MW, MH, BG)
    skin = SKIN[tone]
    cv2.ellipse(img, (360, 770), (165, 190), 0, 0, 360, skin, -1, cv2.LINE_AA)
    xs = [255, 330, 408, 486]
    tops = [320, 280, 300, 360]
    for x, top in zip(xs, tops):
        _capsule(img, (x, top), (x, 640), 33, skin)
    _capsule(img, (250, 660), (165, 560), 33, skin)
    cx, cy, r = 408, 430, 33
    coords = {
        "bodyType": "finger",
        "left": _n(cx - r, cy),
        "right": _n(cx + r, cy),
        "center": _n(cx, cy),
        "width": round((2 * r) / MW, 4),
        "rotation": 0,
    }
    return img, coords


def model_wrist(tone):
    img = _bg(MW, MH, BG)
    skin = SKIN[tone]
    _capsule(img, (360, 430), (360, 880), 92, skin)
    cv2.ellipse(img, (360, 300), (120, 150), 0, 0, 360, skin, -1, cv2.LINE_AA)
    cx, cy, r = 360, 470, 92
    coords = {
        "bodyType": "wrist",
        "left": _n(cx - r, cy),
        "right": _n(cx + r, cy),
        "center": _n(cx, cy),
        "width": round((2 * r) / MW, 4),
        "rotation": 0,
    }
    return img, coords


def model_neck(tone):
    img = _bg(MW, MH, BG)
    skin = SKIN[tone]
    cv2.ellipse(img, (360, 760), (300, 200), 0, 0, 360, skin, -1, cv2.LINE_AA)
    _capsule(img, (360, 320), (360, 500), 72, skin)
    cv2.circle(img, (360, 235), 132, skin, -1, cv2.LINE_AA)
    cx, cy, r = 360, 500, 72
    coords = {
        "bodyType": "neck",
        "left": _n(cx - r, cy),
        "right": _n(cx + r, cy),
        "center": _n(cx, cy),
        "width": round((2 * r) / MW, 4),
        "rotation": 0,
    }
    return img, coords


def model_ear(tone):
    img = _bg(MW, MH, BG)
    skin = SKIN[tone]
    cv2.ellipse(img, (360, 470), (225, 290), 0, 0, 360, skin, -1, cv2.LINE_AA)
    cv2.ellipse(img, (565, 470), (48, 84), 0, 0, 360, skin, -1, cv2.LINE_AA)
    cv2.ellipse(img, (565, 470), (28, 60), 0, 0, 360, tuple(int(c * 0.86) for c in skin), 3, cv2.LINE_AA)
    lobe = (565, 548)
    coords = {
        "bodyType": "ear",
        "center": _n(*lobe),
        "phyToNorm": 0.005,
    }
    return img, coords


# ─── Products (RGBA cutouts) ─────────────────────────────────
def _new_product(w, h):
    rgb = np.full((h, w, 3), 255, np.uint8)
    alpha = np.zeros((h, w), np.uint8)
    return rgb, alpha


def product_ring(metal, gem):
    w = h = 220
    rgb, alpha = _new_product(w, h)
    c, outer, inner = (110, 120), 96, 60
    cv2.circle(alpha, c, outer, 255, -1, cv2.LINE_AA)
    cv2.circle(alpha, c, inner, 0, -1, cv2.LINE_AA)
    cv2.circle(rgb, c, outer, metal, -1, cv2.LINE_AA)
    cv2.circle(rgb, c, inner, (255, 255, 255), -1, cv2.LINE_AA)
    cv2.circle(rgb, c, outer, tuple(int(x * 0.7) for x in metal), 3, cv2.LINE_AA)
    gc, gr = (110, 30), 26
    cv2.circle(alpha, gc, gr, 255, -1, cv2.LINE_AA)
    cv2.circle(rgb, gc, gr, gem, -1, cv2.LINE_AA)
    cv2.circle(rgb, gc, gr, (255, 255, 255), 2, cv2.LINE_AA)
    return rgb, alpha


def product_watch():
    w, h = 320, 200
    rgb, alpha = _new_product(w, h)
    cv2.line(alpha, (40, 100), (280, 100), 255, 84, cv2.LINE_AA)
    cv2.line(rgb, (40, 100), (280, 100), DARK, 84, cv2.LINE_AA)
    cv2.circle(alpha, (160, 100), 74, 255, -1, cv2.LINE_AA)
    cv2.circle(rgb, (160, 100), 74, SILVER, -1, cv2.LINE_AA)
    cv2.circle(rgb, (160, 100), 60, (245, 245, 248), -1, cv2.LINE_AA)
    cv2.line(rgb, (160, 100), (160, 60), DARK, 3, cv2.LINE_AA)
    cv2.line(rgb, (160, 100), (190, 110), DARK, 3, cv2.LINE_AA)
    return rgb, alpha


def product_bracelet(metal):
    w, h = 320, 190
    rgb, alpha = _new_product(w, h)
    c = (160, 95)
    cv2.ellipse(alpha, c, (150, 78), 0, 0, 360, 255, -1, cv2.LINE_AA)
    cv2.ellipse(alpha, c, (118, 50), 0, 0, 360, 0, -1, cv2.LINE_AA)
    cv2.ellipse(rgb, c, (150, 78), 0, 0, 360, metal, -1, cv2.LINE_AA)
    cv2.ellipse(rgb, c, (118, 50), 0, 0, 360, (255, 255, 255), -1, cv2.LINE_AA)
    return rgb, alpha


def product_necklace(metal, gem):
    w, h = 420, 300
    rgb, alpha = _new_product(w, h)
    cv2.ellipse(alpha, (210, 30), (180, 150), 0, 20, 160, 255, 9, cv2.LINE_AA)
    cv2.ellipse(rgb, (210, 30), (180, 150), 0, 20, 160, metal, 9, cv2.LINE_AA)
    pc = (210, 196)
    cv2.circle(alpha, pc, 46, 255, -1, cv2.LINE_AA)
    cv2.circle(rgb, pc, 46, gem, -1, cv2.LINE_AA)
    pts = np.array([[170, 188], [250, 188], [210, 132]], np.int32)
    cv2.fillPoly(alpha, [pts], 255, cv2.LINE_AA)
    cv2.fillPoly(rgb, [pts], gem, cv2.LINE_AA)
    cv2.circle(rgb, pc, 46, (255, 255, 255), 2, cv2.LINE_AA)
    return rgb, alpha


def product_earring(metal, gem):
    w, h = 130, 280
    rgb, alpha = _new_product(w, h)
    cv2.ellipse(alpha, (65, 40), (24, 30), 0, 120, 360, 255, 6, cv2.LINE_AA)
    cv2.ellipse(rgb, (65, 40), (24, 30), 0, 120, 360, metal, 6, cv2.LINE_AA)
    cv2.line(alpha, (65, 66), (65, 150), 255, 5, cv2.LINE_AA)
    cv2.line(rgb, (65, 66), (65, 150), metal, 5, cv2.LINE_AA)
    cv2.circle(alpha, (65, 205), 44, 255, -1, cv2.LINE_AA)
    cv2.circle(rgb, (65, 205), 44, gem, -1, cv2.LINE_AA)
    pts = np.array([[28, 198], [102, 198], [65, 150]], np.int32)
    cv2.fillPoly(alpha, [pts], 255, cv2.LINE_AA)
    cv2.fillPoly(rgb, [pts], gem, cv2.LINE_AA)
    cv2.circle(rgb, (65, 205), 44, (255, 255, 255), 2, cv2.LINE_AA)
    return rgb, alpha


# ─── Seed definitions ────────────────────────────────────────
MODELS = [
    ("finger-sample-light", model_finger, "light", "Light"),
    ("finger-sample-deep", model_finger, "deep", "Deep"),
    ("wrist-sample-light", model_wrist, "light", "Light"),
    ("wrist-sample-tan", model_wrist, "tan", "Tan"),
    ("neck-sample-light", model_neck, "light", "Light"),
    ("ear-sample-light", model_ear, "light", "Light"),
]

PRODUCTS = [
    ("sample-ring-gold", "Classic Gold Ring", "ring", "finger", 18.0, None,
     lambda: product_ring(GOLD, GEM_WHITE)),
    ("sample-ring-rose", "Rose Solitaire", "ring", "finger", 18.0, None,
     lambda: product_ring(ROSE, GEM_BLUE)),
    ("sample-watch", "Round Watch", "watch", "wrist", 40.0, None,
     lambda: product_watch()),
    ("sample-bracelet", "Gold Bangle", "bracelet", "wrist", 62.0, None,
     lambda: product_bracelet(GOLD)),
    ("sample-necklace", "Pendant Necklace", "necklace", "neck", 120.0, None,
     lambda: product_necklace(GOLD, GEM_BLUE)),
    ("sample-earring", "Drop Earring", "earring", "ear", None, 28.0,
     lambda: product_earring(GOLD, GEM_WHITE)),
]


def _asset_url(rel):
    return f"{config.PUBLIC_ASSETS_URL}/assets/{rel}"


def _seed_product(sku, name, category, body_type, width_mm, height_mm, draw):
    info_path = config.PRODUCTS_DIR / f"{sku}-info.json"
    if info_path.exists():
        return False
    rgb, alpha = draw()
    mask = np.where(alpha > 127, 255, 0).astype(np.uint8)
    geom = anchors_mod.compute_anchors(mask, width_mm)
    assets_mod.write_cutout(config.PRODUCTS_DIR / f"{sku}-image.png", rgb, alpha)
    assets_mod.write_mask(config.PRODUCTS_DIR / f"{sku}-mask.png", mask)
    assets_mod.write_rgb(config.PRODUCTS_DIR / f"{sku}-thumb.png", assets_mod.square_thumb(rgb))
    info = {
        "sku": sku,
        "name": name,
        "category": category,
        "bodyType": body_type,
        "widthMm": width_mm,
        "heightMm": height_mm,
        "imageUrl": _asset_url(f"products/_processed/{sku}-image.png"),
        "maskUrl": _asset_url(f"products/_processed/{sku}-mask.png"),
        "thumbUrl": _asset_url(f"products/_processed/{sku}-thumb.png"),
        "imgWidth": geom["imgWidth"],
        "imgHeight": geom["imgHeight"],
        "anchor": geom["anchor"],
        "bbox": geom["bbox"],
        "bboxWidthPx": geom["bboxWidthPx"],
        "pixelsPerMm": geom["pixelsPerMm"],
        "status": "approved",
        "createdAt": time.time(),
    }
    info_path.write_text(__import__("json").dumps(info))
    return True


def _seed_model(model_id, draw, tone, label):
    target = config.MODELS_DIR / model_id
    if (target / "info.json").exists():
        return False
    target.mkdir(parents=True, exist_ok=True)
    rgb, coords = draw(tone)
    assets_mod.write_rgb(target / "image.png", rgb)
    assets_mod.write_rgb(target / "thumb.png", assets_mod.square_thumb(rgb))
    info = {
        "id": model_id,
        "bodyType": coords["bodyType"],
        "label": label,
        "toneId": tone,
        "imageUrl": _asset_url(f"models/{model_id}/image.png"),
        "thumbUrl": _asset_url(f"models/{model_id}/thumb.png"),
        "imgWidth": int(rgb.shape[1]),
        "imgHeight": int(rgb.shape[0]),
        "coords": coords,
        "detectError": None,
        "createdAt": time.time(),
    }
    (target / "info.json").write_text(__import__("json").dumps(info))
    return True


def run():
    config.ensure_dirs()
    p = sum(_seed_product(*spec) for spec in PRODUCTS)
    m = sum(_seed_model(mid, draw, tone, label) for mid, draw, tone, label in MODELS)
    return {"products": p, "models": m}


if __name__ == "__main__":
    result = run()
    print(f"Seeded {result['products']} products, {result['models']} models into {config.STORAGE_DIR}")
