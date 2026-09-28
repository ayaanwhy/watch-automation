"""Ingest the hand-edited ring triples and the gemstone pairs into the cache.

Two sources, two shapes of supervision:

* **rings/edited** — `<sku>.jpg` (the real render, white ground),
  `<sku>;frontFullImage.png` (matte) and `<sku>;frontImage.png` (front layer).
  The jpg is registered to the PNGs so the model can train on a real photograph
  rather than a recomposite. Full supervision: matte + back layer.

* **gems-raw / gems-edited** — a stone photographed on a grey sweep, and the
  retoucher's cut-out (cropped, and often rotated upright). Only the matte is
  supervised; there is no front/back split for a loose stone. The cut-out is
  composited back onto a clean plate inpainted from its own raw frame, which
  keeps the label exact while still showing the model a real background.

    python -m vto.ingest --out data/cache
"""

import argparse
import glob
import json
import os

import cv2
import numpy as np

from vto.data import align_shift, place
from vto.gems import find_gem_pairs, foreground_mask_all


def register_jpg(jpg, matte_rgba, lo=0.08, hi=0.60, steps=27):
    """Locate the flattened render inside the small jpg. Returns (scale, x, y)."""
    a = matte_rgba[..., 3:4].astype(np.float32) / 255.0
    on_white = (matte_rgba[..., :3].astype(np.float32) * a + 255.0 * (1 - a))
    ys, xs = np.nonzero(matte_rgba[..., 3] > 128)
    on_white = on_white[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

    target = jpg.astype(np.float32)
    H, W = target.shape[:2]
    best = (1e18, None)
    for s in np.linspace(lo, hi, steps):
        w, h = int(on_white.shape[1] * s), int(on_white.shape[0] * s)
        if w < 40 or h < 40 or w > W or h > H:
            continue
        t = cv2.resize(on_white, (w, h), interpolation=cv2.INTER_AREA)
        r = cv2.matchTemplate(target, t, cv2.TM_SQDIFF)
        _, _, loc, _ = cv2.minMaxLoc(r)
        patch = target[loc[1]:loc[1] + h, loc[0]:loc[0] + w]
        rmse = float(np.sqrt(((patch - t) ** 2).mean()))
        if rmse < best[0]:
            best = (rmse, (s, loc[0], loc[1], w, h))
    return best


def ingest_ring_triples(root, out, size=512, margin=0.10, groups=None):
    groups = groups or {}
    skus = sorted({os.path.basename(f).split(";")[0].replace(".jpg", "")
                   for f in glob.glob(os.path.join(root, "*"))})
    written = 0
    for sku in skus:
        jpg_p = os.path.join(root, f"{sku}.jpg")
        full_p = os.path.join(root, f"{sku};frontFullImage.png")
        front_p = os.path.join(root, f"{sku};frontImage.png")
        if not all(os.path.isfile(p) for p in (jpg_p, full_p, front_p)):
            continue

        full = cv2.imread(full_p, cv2.IMREAD_UNCHANGED)
        front = cv2.imread(front_p, cv2.IMREAD_UNCHANGED)
        jpg = cv2.imread(jpg_p)
        if full is None or front is None or jpg is None:
            continue

        fa = full[..., 3].astype(np.float32) / 255.0
        ga = front[..., 3].astype(np.float32) / 255.0
        dy, dx = align_shift(fa > 0.5, ga > 0.5)
        ga = place(ga, fa.shape, dy, dx)
        back = ((fa > 0.5) & (ga <= 0.5)).astype(np.float32)

        # (a) the PNG itself, cropped - clean labels, flat ground
        design_id = groups.get(sku, sku)
        _write(out, f"{sku}_png", full[..., :3], fa, back, size, margin,
               has_back=True, design_id=design_id, family="halo", source="edited_png")
        written += 1

        # (b) the real jpg with its labels warped onto it
        rmse, p = register_jpg(jpg, full)
        if p is not None and rmse < 60:
            s, x, y, w, h = p
            ys, xs = np.nonzero(full[..., 3] > 128)
            crop_a = fa[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
            crop_b = back[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
            ja = np.zeros(jpg.shape[:2], np.float32)
            jb = np.zeros(jpg.shape[:2], np.float32)
            ja[y:y + h, x:x + w] = cv2.resize(crop_a, (w, h), interpolation=cv2.INTER_AREA)
            jb[y:y + h, x:x + w] = cv2.resize(crop_b, (w, h), interpolation=cv2.INTER_NEAREST)
            _write(out, f"{sku}_jpg", jpg, ja, jb, size, margin,
                   has_back=True, real=True, design_id=design_id,
                   family="halo", source="original_jpg")
            written += 1
        else:
            print(f"    [!] {sku}: jpg registration rmse={rmse:.1f}, skipped")
    return written


def clean_plate(raw, fg):
    """Inpaint the stone and its shadow away, leaving the bare background."""
    m = cv2.dilate(fg.astype(np.uint8), np.ones((31, 31), np.uint8))
    return cv2.inpaint(raw, m, 9, cv2.INPAINT_TELEA)


def _tight_cutout(ed):
    a = ed[..., 3]
    ys, xs = np.nonzero(a > 8)
    if not len(xs):
        return None
    return (ed[ys.min():ys.max() + 1, xs.min():xs.max() + 1, :3],
            a[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.float32) / 255.0)


def _place_cutouts(plate, cutouts, rng, min_scale=0.18, max_scale=0.42):
    """Composite one or more exact edited mattes onto a clean real plate."""
    H, W = plate.shape[:2]
    comp = plate.astype(np.float32).copy()
    canvas_a = np.zeros((H, W), np.float32)
    occupied = []
    for rgb, al in cutouts:
        want = rng.uniform(min_scale, max_scale) * min(H, W)
        scale = want / max(rgb.shape[:2])
        w, h = max(int(rgb.shape[1] * scale), 8), max(int(rgb.shape[0] * scale), 8)
        if w >= W or h >= H:
            scale = 0.75 * min(W / rgb.shape[1], H / rgb.shape[0])
            w, h = int(rgb.shape[1] * scale), int(rgb.shape[0] * scale)
        rs = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
        aa = cv2.resize(al, (w, h), interpolation=cv2.INTER_AREA)

        position = None
        for _ in range(80):
            x = int(rng.integers(0, max(W - w + 1, 1)))
            y = int(rng.integers(0, max(H - h + 1, 1)))
            box = (x, y, x + w, y + h)
            overlap = any(not (box[2] <= q[0] or q[2] <= box[0] or
                               box[3] <= q[1] or q[3] <= box[1]) for q in occupied)
            if not overlap:
                position = (x, y, box)
                break
        if position is None:
            continue
        x, y, box = position
        sub = comp[y:y + h, x:x + w]
        comp[y:y + h, x:x + w] = rs * aa[..., None] + sub * (1 - aa[..., None])
        canvas_a[y:y + h, x:x + w] = np.maximum(canvas_a[y:y + h, x:x + w], aa)
        occupied.append(box)
    return comp.astype(np.uint8), canvas_a


def ingest_gems(raw_dir, edited_dir, out, size=512, margin=0.12, rng=None,
                multi_count=36):
    rng = rng or np.random.default_rng(0)
    written = 0
    records = []
    for sku, raw_p, ed_p in find_gem_pairs(raw_dir, edited_dir):
        raw = cv2.imread(raw_p)
        ed = cv2.imread(ed_p, cv2.IMREAD_UNCHANGED)
        if raw is None or ed is None or ed.ndim != 3 or ed.shape[2] != 4:
            continue
        fg = foreground_mask_all(raw)
        if fg is None:
            continue
        plate = clean_plate(raw, fg)
        cutout = _tight_cutout(ed)
        if cutout is None:
            continue
        records.append((sku, plate, cutout))
        comp, canvas_a = _place_cutouts(plate, [cutout], rng, 0.30, 0.62)
        _write(out, f"gem_{sku}", comp.astype(np.uint8), canvas_a,
               np.zeros_like(canvas_a), size, margin, has_back=False, real=True,
               design_id=f"gem_{sku}", family="gem", source="synthetic_single")
        written += 1

    # Multi-stone raw images used to poison the cache: only one stone was
    # labelled while the others remained visible as "background".  Generate
    # exact multi-object examples from the edited alpha cut-outs instead.
    if records:
        for i in range(multi_count):
            _, plate, _ = records[int(rng.integers(0, len(records)))]
            n = int(rng.integers(2, 7))
            ids = rng.choice(len(records), size=n, replace=False)
            cuts = [records[int(j)][2] for j in ids]
            comp, canvas_a = _place_cutouts(plate, cuts, rng)
            if (canvas_a > 0.5).sum() < 100:
                continue
            name = f"gemmulti_{i:03d}"
            _write(out, name, comp, canvas_a, np.zeros_like(canvas_a), size, margin,
                   has_back=False, real=True, design_id=name, family="gem",
                   source="synthetic_multi")
            written += 1
    return written


def _write(out, name, bgr, alpha, back, size, margin, has_back, real=False,
           design_id=None, family=None, source=None):
    ys, xs = np.nonzero(alpha > 0.5)
    if not len(xs):
        return
    h, w = alpha.shape
    pad = int(margin * max(ys.ptp() + 1, xs.ptp() + 1))
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, h)
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, w)
    bgr, alpha, back = bgr[y0:y1, x0:x1], alpha[y0:y1, x0:x1], back[y0:y1, x0:x1]

    s = size / max(bgr.shape[:2])
    if s < 1:
        wh = (int(round(bgr.shape[1] * s)), int(round(bgr.shape[0] * s)))
        bgr = cv2.resize(bgr, wh, interpolation=cv2.INTER_AREA)
        alpha = cv2.resize(alpha, wh, interpolation=cv2.INTER_AREA)
        back = cv2.resize(back, wh, interpolation=cv2.INTER_NEAREST)

    d = os.path.join(out, name)
    os.makedirs(d, exist_ok=True)
    cv2.imwrite(os.path.join(d, "img.png"),
                np.dstack([bgr, (alpha * 255).astype(np.uint8)]))
    cv2.imwrite(os.path.join(d, "back.png"), (back * 255).astype(np.uint8))
    meta = {"has_back": bool(has_back), "real_background": bool(real)}
    if design_id is not None:
        meta["design_id"] = str(design_id)
    if family is not None:
        meta["family"] = str(family)
    if source is not None:
        meta["source"] = str(source)
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rings", default="rings/edited")
    p.add_argument("--gems-raw", default="rings/gems-raw")
    p.add_argument("--gems-edited", default="rings/gems-edited")
    p.add_argument("--ring-groups", default="rings/edited/groups.json",
                   help="optional JSON mapping ring SKU to physical design id")
    p.add_argument("--gem-multi", type=int, default=0,
                   help="optional synthetic multi-gem examples (0 for store inputs)")
    p.add_argument("--out", default="data/cache")
    p.add_argument("--size", type=int, default=512)
    args = p.parse_args()
    os.makedirs(args.out, exist_ok=True)

    groups = {}
    if args.ring_groups and os.path.isfile(args.ring_groups):
        with open(args.ring_groups) as f:
            groups = json.load(f)
    n1 = ingest_ring_triples(args.rings, args.out, args.size, groups=groups)
    print(f"[✓] ring entries written: {n1}")
    n2 = ingest_gems(args.gems_raw, args.gems_edited, args.out, args.size,
                     multi_count=args.gem_multi)
    print(f"[✓] gem entries written:  {n2}")


if __name__ == "__main__":
    main()
