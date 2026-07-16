"""Turn a raw BiRefNet matte into a clean cutout: keep the main object, drop
floating background/shadow blobs, remove the background-colour fringe, and
anti-alias the edge. Generic image post-processing for the MIT BiRefNet model.
"""

import cv2
import numpy as np


def clean_stencil(matte: np.ndarray, threshold: int = 127) -> np.ndarray:
    """Threshold to a binary stencil, remove noise specks, and keep the main
    object while preserving genuine interior holes (e.g. chain-link gaps)."""
    _, binary = cv2.threshold(matte, int(threshold), 255, cv2.THRESH_BINARY)

    kernel_small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel_small, iterations=1)

    contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or hierarchy is None:
        return binary

    total_area = binary.shape[0] * binary.shape[1]
    min_area = total_area * 0.0002

    top_level = [i for i in range(len(contours)) if hierarchy[0][i][3] == -1]
    if not top_level:
        return binary

    largest_idx = max(top_level, key=lambda i: cv2.contourArea(contours[i]))
    clean = np.zeros_like(binary)
    cv2.drawContours(clean, contours, largest_idx, 255, -1)

    for i in range(len(contours)):
        if hierarchy[0][i][3] == largest_idx and cv2.contourArea(contours[i]) > min_area:
            cv2.drawContours(clean, contours, i, 0, -1)
            for j in range(len(contours)):
                if hierarchy[0][j][3] == i:
                    cv2.drawContours(clean, contours, j, 255, -1)

    return clean


def decontaminate(image_rgb: np.ndarray, stencil: np.ndarray) -> np.ndarray:
    """Bleed interior colour outward so the feathered edge band carries pure
    object colour instead of the blended background halo."""
    core = cv2.erode(stencil, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1)
    if core.max() == 0:
        core = stencil
    if core.max() == 0:
        return image_rgb

    inv = np.where(core > 0, 0, 255).astype(np.uint8)
    _, labels = cv2.distanceTransformWithLabels(
        inv, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL
    )
    ys, xs = np.where(inv == 0)
    if len(ys) == 0:
        return image_rgb
    idx = np.clip(labels.ravel() - 1, 0, len(ys) - 1)
    bled = image_rgb[ys[idx], xs[idx]].reshape(image_rgb.shape)
    keep = core > 0
    return np.where(keep[:, :, None], image_rgb, bled)


def refine_matte(matte: np.ndarray, image_rgb: np.ndarray, feather: float = None,
                 threshold: int = 127):
    """Return (alpha_u8, decontaminated_rgb). The cleaned stencil decides which
    pixels survive (dropping shadows/floaters); the soft matte is kept only in a
    thin edge band so the contour is anti-aliased without a staircase."""
    stencil = clean_stencil(matte, threshold)
    h, w = matte.shape[:2]
    soft = matte.astype(np.float32)
    if soft.max() <= 1.0:
        soft *= 255.0

    grow = max(1, int(round(max(h, w) / 1024.0)))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow * 2 + 1, grow * 2 + 1))
    core = cv2.erode(stencil, k)
    band = cv2.dilate(stencil, k)
    alpha = np.where(core > 0, 255.0, np.where(band > 0, soft, 0.0)).astype(np.float32)

    fsig = feather if feather is not None else max(0.8, max(h, w) / 1500.0)
    alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=fsig, sigmaY=fsig)
    alpha = np.clip(alpha, 0, 255).astype(np.uint8)

    try:
        decon_rgb = decontaminate(image_rgb, stencil)
    except Exception:
        decon_rgb = image_rgb
    return alpha, decon_rgb


def suppress_light_reflection(stencil: np.ndarray, matte: np.ndarray, image_rgb: np.ndarray) -> np.ndarray:
    """Remove pale low-detail reflection fragments while preserving high-confidence
    jewellery pixels. Intended for studio photos on glossy white surfaces."""
    base = (stencil > 0).astype(np.uint8) * 255
    if base.max() == 0:
        return base

    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    rgb_i = image_rgb.astype(np.float32)
    white_dist = np.sqrt(((255.0 - rgb_i) ** 2).sum(axis=2))
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edge = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    edge = cv2.GaussianBlur(edge, (0, 0), 1.2)

    ys, _ = np.where(base > 0)
    mid_y = int(np.percentile(ys, 55)) if len(ys) else base.shape[0] // 2
    yy = np.indices(base.shape)[0]

    weak = ((base > 0) & (matte < 235) & (sat < 35) & (val > 205) &
            (white_dist < 90) & (edge < 10))
    weak |= ((base > 0) & (matte < 235) & (yy > mid_y) & (sat < 45) &
             (val > 190) & (white_dist < 110) & (edge < 14))

    clean = base.copy()
    clean[weak] = 0
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    clean = cv2.morphologyEx(clean, cv2.MORPH_OPEN, kernel, iterations=1)

    num, labels, stats, _ = cv2.connectedComponentsWithStats(clean, 8)
    if num <= 1:
        return clean
    areas = [stats[i, cv2.CC_STAT_AREA] for i in range(1, num)]
    largest = 1 + int(np.argmax(areas))
    out = np.zeros_like(clean)
    out[labels == largest] = 255

    # Restore tiny enclosed highlight holes, but keep large real openings clear.
    inv = cv2.bitwise_not(out)
    ff = inv.copy()
    h, w = out.shape
    flood_mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, flood_mask, (0, 0), 0)
    num, labels, stats, _ = cv2.connectedComponentsWithStats(ff, 8)
    s = _scale_for(out.shape)
    max_area = int(round(1200 * s * s))
    max_span = int(round(30 * s))
    for i in range(1, num):
        area = stats[i, cv2.CC_STAT_AREA]
        y = stats[i, cv2.CC_STAT_TOP]
        ww = stats[i, cv2.CC_STAT_WIDTH]
        hh = stats[i, cv2.CC_STAT_HEIGHT]
        if area <= max_area and not (y > mid_y and ww > max_span and hh > max_span):
            out[labels == i] = 255
    return out


def _scale_for(shape, ref: int = 2200) -> float:
    return max(shape[:2]) / float(ref)


def _fill_small_holes(stencil: np.ndarray, max_area: int = None,
                      max_span: int = None) -> np.ndarray:
    """Restore small enclosed highlight holes while preserving large real openings."""
    if stencil.max() == 0:
        return stencil
    s = _scale_for(stencil.shape)
    if max_area is None:
        max_area = int(round(4500 * s * s))
    if max_span is None:
        max_span = int(round(90 * s))
    out = stencil.copy()
    inv = cv2.bitwise_not(out)
    ff = inv.copy()
    h, w = out.shape
    flood_mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, flood_mask, (0, 0), 0)
    num, labels, stats, _ = cv2.connectedComponentsWithStats(ff, 8)
    for i in range(1, num):
        area = stats[i, cv2.CC_STAT_AREA]
        ww = stats[i, cv2.CC_STAT_WIDTH]
        hh = stats[i, cv2.CC_STAT_HEIGHT]
        if area <= max_area and not (ww > max_span and hh > max_span):
            out[labels == i] = 255
    return out


def refine_sharp(matte: np.ndarray, image_rgb: np.ndarray, threshold: int = 150,
                 remove_reflection: bool = True):
    """Return (hard_alpha_u8, decontaminated_rgb, binary_mask) for crisp studio cutouts."""
    stencil = clean_stencil(matte, threshold)
    if remove_reflection:
        stencil = suppress_light_reflection(stencil, matte, image_rgb)
    try:
        decon_rgb = decontaminate(image_rgb, stencil)
    except Exception:
        decon_rgb = image_rgb
    return stencil.astype(np.uint8), decon_rgb, stencil.astype(np.uint8)


def refine_studio_white(matte: np.ndarray, image_rgb: np.ndarray):
    """Crisp jewellery cutout for glossy white studio photos: hard matte,
    reflection suppression, and small highlight-hole restoration."""
    stencil = clean_stencil(matte, 150)
    stencil = suppress_light_reflection(stencil, matte, image_rgb)
    stencil = _fill_small_holes(stencil)
    try:
        decon_rgb = decontaminate(image_rgb, stencil)
    except Exception:
        decon_rgb = image_rgb
    return stencil.astype(np.uint8), decon_rgb, stencil.astype(np.uint8)


def _reflection_candidate(image_rgb: np.ndarray, matte: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edge = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    edge = cv2.GaussianBlur(edge, (0, 0), 1.0)
    ys, _ = np.where(matte > 100)
    mid_y = int(np.percentile(ys, 55)) if len(ys) else matte.shape[0] // 2
    yy = np.indices(matte.shape)[0]
    pale_low_detail = ((matte > 110) & (sat < 42) & (val > 185) & (edge < 13))
    lower_reflection = pale_low_detail & (yy > mid_y)
    bright_inner_reflection = ((matte > 120) & (sat < 36) & (val > 202) & (edge < 10))
    return pale_low_detail & (lower_reflection | bright_inner_reflection)


def refine_segmented_studio(matte: np.ndarray, image_rgb: np.ndarray,
                            support_mask: np.ndarray):
    """Use segmentation as a strong product support, then remove only low-detail
    reflection regions that are not backed by nearby jewellery detail."""
    support = (support_mask > 0).astype(np.uint8) * 255
    if support.shape[:2] != matte.shape[:2]:
        support = cv2.resize(support, (matte.shape[1], matte.shape[0]), interpolation=cv2.INTER_NEAREST)

    s = _scale_for(matte.shape)
    support = cv2.dilate(
        support,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(3, int(round(7 * s))) | 1,
                                                      max(3, int(round(7 * s))) | 1)),
        iterations=1,
    )

    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edge = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    edge = cv2.GaussianBlur(edge, (0, 0), 1.0)

    # Seed with both the model matte and SAM support. This prevents pale highlights
    # inside the object support from being dropped just because the matte is low.
    rough = clean_stencil(matte, 118)
    detail = ((support > 0) & (matte > 70) & ((sat > 30) | (val < 205) | (edge > 9))).astype(np.uint8) * 255
    high = ((matte > 190) & ((sat > 22) | (edge > 8))).astype(np.uint8) * 255
    stencil = cv2.bitwise_or(cv2.bitwise_and(support, rough), detail)
    stencil = cv2.bitwise_or(stencil, high)

    # Reflection candidates are removable only when they are not near real product
    # detail. This protects pale bead/charm highlights.
    reflection = _reflection_candidate(image_rgb, matte)
    gold_detail = ((sat > 45) | (val < 178) | ((edge > 18) & ((sat > 24) | (val < 215))))
    protect = ((stencil > 0) & gold_detail).astype(np.uint8) * 255
    pr = max(5, int(round(13 * s))) | 1
    protect = cv2.dilate(protect, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (pr, pr)), iterations=1)
    stencil[(reflection > 0) & (protect == 0)] = 0

    k = max(3, int(round(3 * s))) | 1
    stencil = cv2.morphologyEx(stencil, cv2.MORPH_OPEN,
                               cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)), iterations=1)
    stencil = cv2.morphologyEx(stencil, cv2.MORPH_CLOSE,
                               cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)), iterations=1)

    # Keep the main jewellery component. Small detached residue is discarded.
    num, labels, stats, _ = cv2.connectedComponentsWithStats(stencil, 8)
    if num > 1:
        largest = 1 + int(np.argmax([stats[i, cv2.CC_STAT_AREA] for i in range(1, num)]))
        keep = np.zeros_like(stencil)
        keep[labels == largest] = 255
        stencil = keep

    stencil = _fill_small_holes(stencil)
    try:
        decon_rgb = decontaminate(image_rgb, stencil)
    except Exception:
        decon_rgb = image_rgb
    return stencil.astype(np.uint8), decon_rgb, stencil.astype(np.uint8)
