"""Pair gem cut-outs with their raw photographs.

`gems-edited/<id>;compare.png` is the stone cropped, matted, and often
*rotated* upright by the retoucher; `gems-raw/<id>.jpg` is the original shot on
a grey sweep with a soft shadow. Recovering the transform between them yields a
matte label on a real photographic background, which is what the ring assets -
already cut out against flat white - cannot provide.

Rotation rules out a plain template sweep, so the transform comes from image
moments: centroid, principal axis, and area of the silhouette on each side.
"""

import os

import cv2
import numpy as np


def _shape_stats(mask):
    """Centroid, principal-axis angle (deg) and area of a binary silhouette."""
    m = cv2.moments(mask.astype(np.uint8), binaryImage=True)
    if m["m00"] < 50:
        return None
    cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
    mu20, mu02, mu11 = m["mu20"] / m["m00"], m["mu02"] / m["m00"], m["mu11"] / m["m00"]
    angle = 0.5 * np.degrees(np.arctan2(2 * mu11, mu20 - mu02))
    return np.array([cx, cy]), float(angle), float(m["m00"])


def foreground_components(bgr, border=0.03, tol=14.0, min_relative=0.10):
    """Significant non-background components, excluding soft cast shadows."""
    h, w = bgr.shape[:2]
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    b = max(3, int(round(min(h, w) * border)))
    edge = np.concatenate([lab[:b].reshape(-1, 3), lab[-b:].reshape(-1, 3),
                           lab[:, :b].reshape(-1, 3), lab[:, -b:].reshape(-1, 3)])
    bg = np.median(edge, axis=0)

    dist = np.linalg.norm(lab - bg[None, None, :], axis=2)
    fg = (dist > tol).astype(np.uint8)

    # a shadow keeps the background's chroma and is only slightly darker
    L, a_, b_ = lab[..., 0], lab[..., 1], lab[..., 2]
    shadow = ((np.abs(a_ - bg[1]) < 6) & (np.abs(b_ - bg[2]) < 6) & (L < bg[0]))
    fg[shadow] = 0

    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fg, 8)
    if count < 2:
        return []
    areas = stats[1:, cv2.CC_STAT_AREA]
    cutoff = max(100, float(areas.max()) * min_relative)
    order = np.argsort(areas)[::-1]
    return [(labels == (1 + int(i))) for i in order if areas[i] >= cutoff]


def foreground_mask(bgr, border=0.03, tol=14.0):
    """Largest non-background blob, retained for single-object registration."""
    parts = foreground_components(bgr, border=border, tol=tol)
    return parts[0] if parts else None


def foreground_mask_all(bgr, border=0.03, tol=14.0):
    """Union of every significant object on the photographic background."""
    parts = foreground_components(bgr, border=border, tol=tol)
    if not parts:
        return None
    return np.logical_or.reduce(parts)


def _tight(ed):
    a = ed[..., 3]
    ys, xs = np.nonzero(a > 128)
    if not len(xs):
        return None, None
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return ed[y0:y1, x0:x1, :3], ed[y0:y1, x0:x1, 3]


def _warp(alpha_src, rgb_src, shape, scale, angle, src_c, dst_c):
    M = cv2.getRotationMatrix2D((float(src_c[0]), float(src_c[1])), angle, scale)
    M[0, 2] += dst_c[0] - src_c[0]
    M[1, 2] += dst_c[1] - src_c[1]
    a = cv2.warpAffine(alpha_src, M, (shape[1], shape[0]), flags=cv2.INTER_LINEAR,
                       borderValue=0)
    r = cv2.warpAffine(rgb_src, M, (shape[1], shape[0]), flags=cv2.INTER_LINEAR,
                       borderValue=0)
    return a, r


def build_pair(raw_path, edited_path, min_agree=0.80):
    """Return (raw_bgr, alpha, agreement) with the cut-out placed on the raw frame."""
    raw = cv2.imread(raw_path)
    ed = cv2.imread(edited_path, cv2.IMREAD_UNCHANGED)
    if raw is None or ed is None or ed.ndim != 3 or ed.shape[2] != 4:
        return None

    fg = foreground_mask(raw)
    if fg is None:
        return None
    dst = _shape_stats(fg)
    rgb_s, alpha_s = _tight(ed)
    if dst is None or rgb_s is None:
        return None
    src = _shape_stats(alpha_s > 128)
    if src is None:
        return None

    dst_c, dst_ang, dst_area = dst
    src_c, src_ang, src_area = src
    scale = float(np.sqrt(dst_area / max(src_area, 1.0)))

    # the principal axis is defined mod 180, so both flips must be tried
    best = None
    for extra in (0.0, 180.0):
        angle = (src_ang - dst_ang) + extra
        a, _ = _warp(alpha_s.astype(np.float32) / 255.0,
                     rgb_s.astype(np.float32), raw.shape[:2], scale, angle, src_c, dst_c)
        pred = a > 0.5
        inter = (pred & fg).sum()
        union = (pred | fg).sum()
        agree = inter / max(union, 1)
        if best is None or agree > best[0]:
            best = (agree, np.clip(a, 0, 1))

    agree, alpha = best
    if agree < min_agree:
        return None
    return raw, alpha, float(agree)


def find_gem_pairs(raw_dir, edited_dir, suffix=";compare.png"):
    pairs = []
    for f in sorted(os.listdir(raw_dir)):
        sku = os.path.splitext(f)[0]
        e = os.path.join(edited_dir, sku + suffix)
        if os.path.isfile(e):
            pairs.append((sku, os.path.join(raw_dir, f), e))
    return pairs
