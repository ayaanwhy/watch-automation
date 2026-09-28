"""Turn raw model output into clean RGBA layers.

Two corrections matter once the layers are composited over a dark background:

* **Colour decontamination.** A matte only gives alpha; the RGB of a partly
  transparent edge pixel is still the observed blend of ring and background.
  Composite that over black and the leftover white shows as a bright fringe.
  Given I = a*F + (1-a)*B with a known background B, the true foreground is
  F = (I - (1-a)B) / a.

* **A real partition.** front and back must sum to the matte exactly, or the
  seam keeps a rim of the layer that was supposed to be removed.
"""

import cv2
import numpy as np


def estimate_background(bgr, border=0.04):
    h, w = bgr.shape[:2]
    b = max(2, int(round(min(h, w) * border)))
    edges = np.concatenate([bgr[:b].reshape(-1, 3), bgr[-b:].reshape(-1, 3),
                            bgr[:, :b].reshape(-1, 3), bgr[:, -b:].reshape(-1, 3)])
    return np.median(edges, axis=0).astype(np.float32)


def decontaminate(bgr, alpha, background=None, min_alpha=0.06,
                  extend_edge=True):
    """Recover unmixed foreground colour so edges do not glow on dark ground.

    A two-sided subpixel matte necessarily gives a little alpha to pixels just
    outside the binary contour.  Their source RGB is the catalogue canvas, not
    jewellery, so ordinary decontamination cannot recover a useful colour.
    Extrapolate the nearest opaque edge colour into that narrow fringe.  This
    is the standard companion operation to an outward antialiased alpha and is
    what prevents a white halo on dark try-on backgrounds.
    """
    if background is None:
        background = estimate_background(bgr)
    img = bgr.astype(np.float32)
    a = np.clip(alpha, 0.0, 1.0)[..., None]
    fg = (img - (1.0 - a) * background[None, None, :]) / np.maximum(a, min_alpha)
    fg = np.where(a >= min_alpha, fg, img)      # too transparent to recover
    fg = np.clip(fg, 0, 255)
    if extend_edge:
        scalar = a[..., 0]
        solid = (scalar > 0.5).astype(np.float32)
        fringe = (scalar > 0.0) & (solid == 0)
        if fringe.any() and solid.any():
            weight = cv2.GaussianBlur(solid, (0, 0), 1.0)
            colours = np.stack([
                cv2.GaussianBlur(fg[..., channel] * solid, (0, 0), 1.0)
                for channel in range(3)
            ], axis=2)
            extended = colours / np.maximum(weight[..., None], 1e-5)
            use = fringe & (weight > 1e-5)
            fg[use] = extended[use]
    return np.clip(fg, 0, 255).astype(np.uint8)


def sharpen_alpha(alpha, k=6.0):
    """Steepen the probability into a matte as hard as the training assets.

    The retouchers' PNGs are effectively binary - measured partial-alpha ratio
    0.005 median, 0.017 max. A raw sigmoid output sits around 0.07, i.e. a wide
    skirt of barely-transparent pixels. Harmless on white, a grey halo on a dark
    background. This keeps the sub-pixel edge but removes the skirt; it is
    symmetric about 0.5, so the opaque region is unchanged.
    """
    return np.clip((np.asarray(alpha, np.float32) - 0.5) * k + 0.5, 0.0, 1.0)


def trim_background_edge(alpha, bgr, background=None, radius=1.5, tol=12.0,
                         texture_tol=0.0):
    """Reduce white-canvas spill only in the innermost silhouette edge.

    A broad colour key is unsafe because white gemstone facets can genuinely
    equal the catalogue background.  Restricting it to roughly one source
    pixel of the model contour removes the remaining JPEG canvas slivers while
    leaving the semantic interior (and therefore pale facets) untouched.
    The result is a soft alpha estimate rather than a hard deletion.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0).copy()
    if radius <= 0 or tol <= 0:
        return a
    if background is None:
        background = estimate_background(bgr)

    solid = (a > 0.5).astype(np.uint8)
    distance = cv2.distanceTransform(solid, cv2.DIST_L2, 5)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg_lab = cv2.cvtColor(background.reshape(1, 1, 3).astype(np.uint8),
                          cv2.COLOR_BGR2LAB).astype(np.float32).reshape(3)
    colour_distance = np.linalg.norm(lab - bg_lab[None, None, :], axis=2)
    edge = (distance > 0) & (distance <= float(radius))
    if texture_tol > 0:
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
        mean = cv2.blur(gray, (5, 5))
        variance = cv2.blur(gray * gray, (5, 5)) - mean * mean
        local_std = np.sqrt(np.maximum(variance, 0.0))
        edge &= local_std < float(texture_tol)
    a[edge] = np.minimum(a[edge], np.clip(colour_distance[edge] / tol, 0.0, 1.0))
    return a


def antialias_inward(alpha, sigma=0.6, edge_sigma=0.55):
    """Smooth a jagged contour without adding a translucent outer fringe.

    Blurring alpha in both directions puts white source RGB outside the item,
    which glows over dark skin/backgrounds.  This first smooths the binary
    contour and then keeps antialiasing strictly on its inside edge.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    if sigma <= 0:
        return a.copy()
    solid = (a > 0.5).astype(np.float32)
    shape = (cv2.GaussianBlur(solid, (0, 0), float(sigma)) > 0.5).astype(np.float32)
    soft = cv2.GaussianBlur(shape, (0, 0), float(edge_sigma))
    return soft * shape


def antialias_subpixel(alpha, sigma=0.6, edge_sigma=0.85):
    """Create a smooth two-sided contour without changing its binary shape.

    The semantic contour is authoritative: even a one-pixel diagonal prong or
    stone must survive post-processing.  Smooth only coverage around that
    contour; do not blur and re-threshold the contour itself.  The neighbouring
    outside pixel receives partial coverage, and both sides of 0.5 are clamped
    so the encoded binary silhouette remains exactly ``alpha > 0.5``.  Values
    that would round to zero in an 8-bit PNG are discarded.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    if sigma <= 0:
        return a.copy()
    shape = a > 0.5
    if edge_sigma <= 0:
        return shape.astype(np.float32)
    soft = cv2.GaussianBlur(shape.astype(np.float32), (0, 0),
                            float(edge_sigma))
    # 128/255 and 127/255 keep encoded binary membership deterministic.
    soft[shape] = np.maximum(soft[shape], 128.0 / 255.0)
    soft[~shape] = np.minimum(soft[~shape], 127.0 / 255.0)
    soft[soft < 0.5 / 255.0] = 0.0
    return np.clip(soft, 0.0, 1.0)


def smooth_gem_matte(alpha, epsilon=1.2, supersample=8,
                     epsilon_reference=500.0, max_render_side=4096):
    """Reconstruct a clean subpixel contour for a single loose gemstone.

    The semantic model predicts on a fixed 384px raster.  Resizing its hard
    mask back to the uploaded image exposes that raster as a scalloped edge.
    A small Douglas-Peucker tolerance removes only subpixel contour steps;
    genuine emerald corners and marquise/pear tips remain salient vertices.
    The resulting polygon is filled on a bounded supersampled ROI and reduced
    with area coverage, producing a true antialiased matte instead of blurring
    foreground colour into the background.

    ``epsilon`` is expressed in pixels at a 500px stone extent and grows only
    for unusually large uploads.  Rendering is limited to ``max_render_side``
    per ROI dimension so a large source cannot cause an excessive allocation.
    """
    shape = np.asarray(alpha, np.float32) > 0.5
    if not shape.any():
        return shape.astype(np.float32)

    contours, _ = cv2.findContours(
        shape.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return shape.astype(np.float32)
    contour = max(contours, key=cv2.contourArea)
    left, top, width, height = cv2.boundingRect(contour)
    extent = max(width, height)
    scaled_epsilon = float(epsilon) * max(
        1.0, extent / max(float(epsilon_reference), 1.0))
    polygon = cv2.approxPolyDP(contour, scaled_epsilon, True)
    if len(polygon) < 3:
        return shape.astype(np.float32)

    # Include the half-pixel outline and its antialias coverage in the ROI.
    pad = 2
    x0, y0 = max(left - pad, 0), max(top - pad, 0)
    x1 = min(left + width + pad, shape.shape[1])
    y1 = min(top + height + pad, shape.shape[0])
    roi_width, roi_height = x1 - x0, y1 - y0
    requested_scale = max(1, int(supersample))
    bounded_scale = max(1, int(max_render_side) // max(
        roi_width, roi_height, 1))
    scale = min(requested_scale, bounded_scale)

    points = polygon[:, 0, :].astype(np.float32)
    points[:, 0] -= x0
    points[:, 1] -= y0
    # Contour coordinates denote boundary-pixel centres.  A half-pixel-wide
    # outline restores the corresponding pixel-cell extent after polygon fill.
    high_points = np.rint((points + 0.5) * scale - 0.5).astype(np.int32)
    high = np.zeros((roi_height * scale, roi_width * scale), np.uint8)
    cv2.fillPoly(high, [high_points], 255, lineType=cv2.LINE_AA)
    cv2.polylines(high, [high_points], True, 255, thickness=scale,
                  lineType=cv2.LINE_AA)
    coverage = cv2.resize(high.astype(np.float32) / 255.0,
                          (roi_width, roi_height),
                          interpolation=cv2.INTER_AREA)

    matte = np.zeros(shape.shape, np.float32)
    matte[y0:y1, x0:x1] = coverage
    matte[matte < 0.5 / 255.0] = 0.0
    return np.clip(matte, 0.0, 1.0)


def refine_plain_background_contour(alpha, bgr, radius=4, iterations=1,
                                    max_border_std=2.5):
    """Recover source-supported detail just outside a coarse ring matte.

    The semantic network runs on a reduced raster and can miss a few native
    pixels along pale shoulder rails.  Buchroeders' configurator renders have
    an exceptionally uniform canvas, so GrabCut can safely snap only that
    narrow contour band to the native source.  Existing foreground is a hard
    invariant: this helper only adds pixels, never erodes a predicted prong,
    stone or metal edge.

    The refinement is disabled for non-uniform borders and is evaluated on a
    tight ROI.  Consequently arbitrary photos do not get treated as catalogue
    renders and the CPU cost does not scale with the full canvas area.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    image = np.asarray(bgr, np.uint8)
    if radius <= 0 or iterations <= 0 or image.ndim != 3:
        return a.copy()
    solid = a > 0.5
    if not solid.any():
        return a.copy()

    height, width = solid.shape
    border_size = max(2, int(round(min(height, width) * 0.03)))
    border = np.concatenate([
        image[:border_size].reshape(-1, 3),
        image[-border_size:].reshape(-1, 3),
        image[:, :border_size].reshape(-1, 3),
        image[:, -border_size:].reshape(-1, 3),
    ])
    # Median absolute deviation is robust to a product touching a small part
    # of the frame while still rejecting a photographic/gradient background.
    median = np.median(border, axis=0)
    deviation = np.median(np.abs(border.astype(np.float32) - median), axis=0)
    if float(deviation.max()) > float(max_border_std):
        return a.copy()

    ys, xs = np.nonzero(solid)
    margin = int(radius) + 3
    y0, y1 = max(int(ys.min()) - margin, 0), min(int(ys.max()) + margin + 1,
                                                height)
    x0, x1 = max(int(xs.min()) - margin, 0), min(int(xs.max()) + margin + 1,
                                                width)
    crop_solid = solid[y0:y1, x0:x1].astype(np.uint8)
    crop_image = image[y0:y1, x0:x1]
    near_kernel = np.ones((2 * int(radius) + 1,) * 2, np.uint8)
    near = cv2.dilate(crop_solid, near_kernel) > 0
    sure = cv2.erode(crop_solid, np.ones((5, 5), np.uint8)) > 0

    labels = np.full(crop_solid.shape, cv2.GC_BGD, np.uint8)
    labels[near] = cv2.GC_PR_BGD
    labels[crop_solid > 0] = cv2.GC_PR_FGD
    labels[sure] = cv2.GC_FGD
    background_model = np.zeros((1, 65), np.float64)
    foreground_model = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(crop_image, labels, None, background_model,
                    foreground_model, int(iterations), cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        return a.copy()

    source_foreground = np.isin(labels, (cv2.GC_FGD, cv2.GC_PR_FGD))
    recovered = crop_solid.astype(bool) | (source_foreground & near)
    result = a.copy()
    target = result[y0:y1, x0:x1]
    target[recovered & ~crop_solid.astype(bool)] = 1.0
    return result


def repair_upper_ring_opening(alpha, window=41, max_depth=15,
                              min_width_fraction=0.35,
                              min_area_fraction=0.03):
    """Fill narrow model notches along a ring's enclosed finger opening.

    Pale inner shoulder metal can be indistinguishable from the white source
    canvas, so a colour snap cannot recover it.  A front-facing ring gives us
    a stronger geometric invariant: the finger opening is the largest enclosed
    background component and its upper edge is locally smooth.  Close only
    short upward notches in that one edge, bounded by ``max_depth``.  The outer
    silhouette, centre stone, prongs, and every other hole are untouched.

    ``window`` and ``max_depth`` are expressed at the legacy 499px reference
    size and scaled to the source raster.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0).copy()
    solid = a > 0.5
    if not solid.any() or window < 3 or max_depth <= 0:
        return a

    height, width = solid.shape
    background = (~solid).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(background, 8)
    candidates = []
    for index in range(1, count):
        touches_border = (
            np.any(labels[0] == index) or np.any(labels[-1] == index) or
            np.any(labels[:, 0] == index) or np.any(labels[:, -1] == index)
        )
        if not touches_border:
            candidates.append(index)
    if not candidates:
        return a

    opening = max(candidates, key=lambda index: stats[index, cv2.CC_STAT_AREA])
    item_y, item_x = np.nonzero(solid)
    item_width = int(item_x.max() - item_x.min() + 1)
    opening_area = int(stats[opening, cv2.CC_STAT_AREA])
    left, _, span, _ = map(int, stats[opening, :4])
    if (span < float(min_width_fraction) * item_width or
            opening_area < float(min_area_fraction) * int(solid.sum())):
        return a

    top = np.full(span, height, np.float32)
    for offset, x in enumerate(range(left, left + span)):
        rows = np.flatnonzero(labels[:, x] == opening)
        if len(rows):
            top[offset] = float(rows[0])
    valid = top < height
    known = np.flatnonzero(valid)
    if len(known) < 3:
        return a
    top = np.interp(np.arange(span), known, top[known]).astype(np.float32)

    scale = min(height, width) / 499.0
    scaled_window = max(3, int(round(float(window) * scale)) | 1)
    scaled_window = min(scaled_window, span if span % 2 else span - 1)
    scaled_depth = max(1, int(round(float(max_depth) * scale)))
    if scaled_window < 3:
        return a
    envelope = cv2.morphologyEx(
        top.reshape(1, -1), cv2.MORPH_CLOSE,
        np.ones((1, scaled_window), np.uint8)).reshape(-1)

    for offset in range(span):
        depth = int(round(envelope[offset] - top[offset]))
        if depth <= 1 or depth > scaled_depth:
            continue
        x = left + offset
        y0, y1 = int(round(top[offset])), int(round(envelope[offset]))
        belongs_to_opening = labels[y0:y1, x] == opening
        a[y0:y1, x][belongs_to_opening] = 1.0
    return a


def recover_plain_background_edges(alpha, bgr, radius=6, colour_tol=8.0,
                                   close_size=3, max_border_std=2.5,
                                   shoulder_height_fraction=0.16):
    """Recover dark/coloured shoulder edge evidence missed on white canvas.

    A pale rail can disappear from the semantic matte while its thin darker
    outline remains unambiguous in the native source.  Recover only source
    pixels that differ materially from a uniform catalogue background, are
    attached to the existing item, and lie in the two shoulder zones around
    the largest enclosed finger opening.  This deliberately excludes the
    centre head and lower outer silhouette, where shadows or gemstone facets
    must not be expanded.

    ``radius`` is expressed at the legacy 499px reference size.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0).copy()
    image = np.asarray(bgr, np.uint8)
    solid = a > 0.5
    if (not solid.any() or radius <= 0 or colour_tol <= 0 or
            image.ndim != 3):
        return a

    height, width = solid.shape
    border_size = max(2, int(round(min(height, width) * 0.03)))
    border = np.concatenate([
        image[:border_size].reshape(-1, 3),
        image[-border_size:].reshape(-1, 3),
        image[:, :border_size].reshape(-1, 3),
        image[:, -border_size:].reshape(-1, 3),
    ])
    background = np.median(border, axis=0)
    deviation = np.median(
        np.abs(border.astype(np.float32) - background), axis=0)
    if float(deviation.max()) > float(max_border_std):
        return a

    background_mask = (~solid).astype(np.uint8)
    count, hole_labels, stats, _ = cv2.connectedComponentsWithStats(
        background_mask, 8)
    holes = []
    for index in range(1, count):
        touches_border = (
            np.any(hole_labels[0] == index) or
            np.any(hole_labels[-1] == index) or
            np.any(hole_labels[:, 0] == index) or
            np.any(hole_labels[:, -1] == index)
        )
        if not touches_border:
            holes.append(index)
    if not holes:
        return a
    opening = max(holes, key=lambda index: stats[index, cv2.CC_STAT_AREA])

    ys, xs = np.nonzero(solid)
    item_width = int(xs.max() - xs.min() + 1)
    _, oy, _, _ = map(int, stats[opening, :4])
    if int(stats[opening, cv2.CC_STAT_WIDTH]) < 0.35 * item_width:
        return a
    centre = 0.5 * (float(xs.min()) + float(xs.max()))
    region = np.zeros_like(solid)
    # Low-set heads can place the diagonal shoulder rail about 15% of the
    # item width above the finger opening.  The centre-head exclusion below
    # keeps this taller search band away from gemstone facets.
    y0 = max(0, int(round(
        oy - float(shoulder_height_fraction) * item_width)))
    # Some support rails enter the finger opening by only a few pixels.  Keep
    # this allowance narrow: an earlier whole-opening search also collected
    # lower-band reflections as detached fragments.
    y1 = min(height, int(round(oy + 0.02 * item_width)) + 1)
    region[y0:y1] = True
    half_exclusion = 0.12 * item_width
    centre_left = max(0, int(np.floor(centre - half_exclusion)))
    centre_right = min(width, int(np.ceil(centre + half_exclusion + 1)))
    region[:, centre_left:centre_right] = False

    scaled_radius = max(1, int(round(float(radius) * min(height, width) /
                                     499.0)))
    near = cv2.dilate(
        solid.astype(np.uint8),
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (2 * scaled_radius + 1,) * 2)) > 0
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg_lab = cv2.cvtColor(background.reshape(1, 1, 3).astype(np.uint8),
                          cv2.COLOR_BGR2LAB).astype(np.float32).reshape(3)
    colour_distance = np.linalg.norm(lab - bg_lab[None, None, :], axis=2)
    evidence = near & region & (colour_distance >= float(colour_tol))
    if not evidence.any():
        return a

    seeded = solid | evidence
    kernel_size = max(1, int(close_size) | 1)
    closed = cv2.morphologyEx(
        seeded.astype(np.uint8), cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (kernel_size, kernel_size))) > 0
    component_count, component_labels = cv2.connectedComponents(
        closed.astype(np.uint8), 8)
    if component_count <= 1:
        return a
    attached = np.unique(component_labels[solid])
    attached = attached[attached != 0]
    if not len(attached):
        return a
    recovered = np.isin(component_labels, attached) & near & region
    a[recovered] = 1.0
    return a


def repair_shoulder_slits(alpha, max_area_fraction=0.0015,
                          max_height_fraction=0.04,
                          min_aspect=2.0,
                          shoulder_height_fraction=0.16,
                          opening_margin_fraction=0.03):
    """Fill narrow enclosed transparency slits in front-facing shoulders.

    White-on-white catalogue rendering can make a pale shoulder surface
    invisible except for its darker outline.  Once that outline is recovered,
    a small triangular or horizontal transparent island can remain inside the
    metal.  It is not the finger opening: it is far smaller, horizontally
    elongated and located to one side of the head.  Fill only holes satisfying
    all of those geometric constraints.  Round/vertical gallery openings and
    the large finger opening remain untouched.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0).copy()
    solid = a > 0.5
    if not solid.any():
        return a

    height, width = solid.shape
    background = (~solid).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(background, 8)
    holes = []
    for index in range(1, count):
        touches_border = (
            np.any(labels[0] == index) or np.any(labels[-1] == index) or
            np.any(labels[:, 0] == index) or np.any(labels[:, -1] == index)
        )
        if not touches_border:
            holes.append(index)
    if len(holes) < 2:
        return a

    opening = max(holes, key=lambda index: stats[index, cv2.CC_STAT_AREA])
    ys, xs = np.nonzero(solid)
    item_width = int(xs.max() - xs.min() + 1)
    if int(stats[opening, cv2.CC_STAT_WIDTH]) < 0.35 * item_width:
        return a
    item_area = int(solid.sum())
    centre = 0.5 * (float(xs.min()) + float(xs.max()))
    opening_top = int(stats[opening, cv2.CC_STAT_TOP])
    min_y = opening_top - float(shoulder_height_fraction) * item_width
    max_y = opening_top + float(opening_margin_fraction) * item_width
    central_half_width = 0.12 * item_width

    for index in holes:
        if index == opening:
            continue
        left, top, span, hole_height, area = map(int, stats[index])
        hole_centre_x = left + 0.5 * (span - 1)
        hole_centre_y = top + 0.5 * (hole_height - 1)
        if area > float(max_area_fraction) * item_area:
            continue
        if hole_height > float(max_height_fraction) * item_width:
            continue
        if span / max(hole_height, 1) < float(min_aspect):
            continue
        if abs(hole_centre_x - centre) <= central_half_width:
            continue
        if not (min_y <= hole_centre_y <= max_y):
            continue
        a[labels == index] = 1.0
    return a


def remove_alpha_specks(alpha, min_pixels=32, keep_largest=False):
    """Delete disconnected matte components visible in the encoded output.

    This operates on nonzero 8-bit support, not only ``alpha > 0.5``.  The old
    cleanup missed partial-alpha dust for exactly that reason.  Rings retain
    substantial disconnected details; known single-gem inputs may request the
    stricter ``keep_largest`` policy.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0).copy()
    support = (np.rint(a * 255.0) > 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(support, 8)
    if count <= 1:
        return a
    areas = stats[1:, cv2.CC_STAT_AREA]
    largest = 1 + int(np.argmax(areas)) if len(areas) else 0
    for index in range(1, count):
        if (keep_largest and index != largest) or (
                not keep_largest and stats[index, cv2.CC_STAT_AREA] < int(min_pixels)):
            a[labels == index] = 0.0
    return a


def clean_gem_silhouette(alpha, bgr=None, erode=1, tail_fraction=0.22,
                         max_tail_fraction=0.04, min_growth=12,
                         growth_ratio=1.12, texture_threshold=6.0):
    """Remove the thin canvas shell and a connected display reflection.

    Loose-gem catalogue renders are much tighter than the ring renders.  The
    semantic matte consequently keeps a one-pixel gray shell, and pointed
    stones can include the little pedestal/reflection below their tip as part
    of the same connected object.  A one-pixel erosion is negligible at the
    500–800px gem sizes but removes that shell before subpixel antialiasing.

    A real pointed outline narrows monotonically toward the bottom.  A support
    reflection does the opposite: after a narrow neck it widens again at the
    image boundary.  Trim only that short, widening tail.  Tight flat-cut
    renders can also contain a few nearly textureless reflection rows at the
    top or bottom; those are removed only for a highly symmetric, elongated
    silhouette.  Finally, close a cropped tapered tip over a handful of rows
    so removing its reflection does not leave a visibly flat stump.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    shape = a > 0.5
    if not shape.any():
        return shape.astype(np.float32)

    h, _ = shape.shape
    ys, xs = np.nonzero(shape)
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    crop = shape[y0:y1 + 1]
    vertical_dice = (2.0 * np.logical_and(crop, crop[::-1]).sum() /
                     max(2 * int(crop.sum()), 1))
    aspect = (y1 - y0 + 1) / max(x1 - x0 + 1, 1)

    # Emerald/rectangular catalogue renders sometimes have a smooth gray
    # display ledge at both ends.  Texture is safe here only after the semantic
    # mask, shape symmetry and aspect ratio have jointly identified a flat-cut
    # stone; applying it to every pale gem would erase legitimate facets.
    if (bgr is not None and vertical_dice >= 0.95 and
            1.25 <= aspect <= 1.65 and texture_threshold > 0):
        gray = cv2.cvtColor(np.asarray(bgr, np.uint8),
                            cv2.COLOR_BGR2GRAY).astype(np.float32)
        mean = cv2.blur(gray, (5, 5))
        local_std = np.sqrt(np.maximum(
            cv2.blur(gray * gray, (5, 5)) - mean * mean, 0.0))
        max_rows = max(3, int(round((y1 - y0 + 1) * 0.03)))

        def textured(row):
            values = local_std[row, shape[row]]
            return bool(len(values) and
                        np.median(values) >= float(texture_threshold))

        top_keep = y0
        for row in range(y0, min(y0 + max_rows, y1)):
            if textured(row) and textured(row + 1):
                top_keep = row
                break
            top_keep = row + 1
        bottom_keep = y1
        for row in range(y1, max(y1 - max_rows, y0), -1):
            if textured(row) and textured(row - 1):
                bottom_keep = row
                break
            bottom_keep = row - 1
        shape[:top_keep] = False
        shape[bottom_keep + 1:] = False

    widths = shape.sum(axis=1)
    start = min(h - 1, max(0, int(round(h * (1.0 - tail_fraction)))))
    candidates = np.nonzero(widths[start:])[0]
    if shape[-1].any() and len(candidates):
        neck = start + int(candidates[np.argmin(widths[start:][candidates])])
        tail_rows = h - 1 - neck
        allowed_rows = max(18, int(round(h * max_tail_fraction)))
        neck_width = int(widths[neck])
        end_width = int(widths[-1])
        if (tail_rows <= allowed_rows and
                end_width - neck_width >= int(min_growth) and
                end_width >= neck_width * float(growth_ratio)):
            shape[neck + 1:] = False

    # A reflection trim can expose the last broad raster row of a pointed or
    # rounded end.  Restrict only the final 1--2% of elongated stones so the
    # contour closes naturally instead of ending as a horizontal gray shelf.
    ys, xs = np.nonzero(shape)
    if len(ys):
        y0, y1 = int(ys.min()), int(ys.max())
        x0, x1 = int(xs.min()), int(xs.max())
        height, width = y1 - y0 + 1, x1 - x0 + 1
        aspect = height / max(width, 1)
        row_widths = shape.sum(axis=1)
        max_width = max(int(row_widths.max()), 1)
        midpoints = []
        for row in range(y0, y1 + 1):
            occupied = np.flatnonzero(shape[row])
            if len(occupied):
                midpoints.append((occupied[0] + occupied[-1]) / 2.0)
        axis = float(np.median(midpoints))

        def close_end(start, end, pointed):
            rows = abs(end - start)
            if rows < 2:
                return
            anchor_width = int(row_widths[start])
            direction = 1 if end > start else -1
            for offset in range(rows + 1):
                row = start + direction * offset
                t = offset / rows
                scale = ((1.0 - t) if pointed else
                         np.sqrt(max(0.0, 1.0 - t * t)))
                wanted = max(1, int(round(anchor_width * scale)))
                left = int(np.floor(axis - wanted / 2.0))
                right = left + wanted
                keep = np.zeros(shape.shape[1], dtype=bool)
                keep[max(left, 0):min(right, shape.shape[1])] = True
                shape[row] &= keep

        if aspect >= 1.30:
            first_ratio = row_widths[y0] / max_width
            last_ratio = row_widths[y1] / max_width
            if first_ratio < 0.40:
                cap = min(max(5, int(round(height * 0.01))), y1 - y0)
                close_end(y0 + cap, y0, pointed=True)
            if last_ratio < 0.40:
                cap_fraction = 0.01 if aspect >= 1.70 else 0.018
                cap = min(max(6, int(round(height * cap_fraction))), y1 - y0)
                close_end(y1 - cap, y1, pointed=aspect >= 1.70)

    if erode > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        shape = cv2.erode(
            shape.astype(np.uint8), kernel, iterations=int(erode),
            borderType=cv2.BORDER_CONSTANT, borderValue=0) > 0
    return shape.astype(np.float32)


def split_layers(alpha, back_prob, thr=0.5, feather=0.0, sharpen=6.0, expand=1):
    """Partition the matte into front and back so the two sum back to it.

    The occlusion seam must be hard: a feather shares a bright ring edge with
    ``front.png``, where it remains visible over the hand as a hairline.  One
    pixel of expansion assigns antialiased/resized seam pixels to the back.
    The full matte still supplies the true outer-edge antialiasing.
    """
    a = sharpen_alpha(alpha, sharpen) if sharpen else np.clip(alpha, 0.0, 1.0)
    m = (np.clip(back_prob, 0.0, 1.0) > thr).astype(np.uint8)
    if expand > 0:
        m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=int(expand))
    m = m.astype(np.float32)
    if feather > 0:
        m = cv2.GaussianBlur(m, (0, 0), feather)
    m = np.clip(m, 0.0, 1.0)
    # Two-sided antialiasing adds partial coverage just outside the solid
    # contour.  Assign those new pixels from the nearest solid layer; otherwise
    # the outside rim of the rear band can leak into the front PNG.
    solid = a > 0.5
    outer = (a > 0.0) & ~solid
    if outer.any():
        back_solid = ((m > 0.5) & solid).astype(np.uint8)
        nearest_back = cv2.dilate(back_solid, np.ones((5, 5), np.uint8)) > 0
        m[outer] = nearest_back[outer].astype(np.float32)
    back = a * m
    front = a * (1.0 - m)
    return a, front, back


def resize_layer_partition(alpha, back, output_shape):
    """Resize a matte while keeping front/back ownership categorical.

    Outer alpha is continuous coverage and therefore uses area resampling.
    Internal ownership is a class: interpolating it would put the same seam
    pixel into both PNGs and create a floating line when a hand is composited
    between them.  Reduce the rear class by majority and derive both layers
    from the one resized matte so the partition stays exact.

    ``output_shape`` is ``(height, width)`` to match NumPy image shapes.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    b = np.clip(np.asarray(back, np.float32), 0.0, 1.0)
    if a.ndim != 2 or b.shape != a.shape:
        raise ValueError("alpha and back must be equal 2D arrays")
    height, width = map(int, output_shape)
    if height <= 0 or width <= 0:
        raise ValueError("output shape must be positive")
    size = (width, height)
    resized_alpha = cv2.resize(a, size, interpolation=cv2.INTER_AREA)
    resized_alpha = np.clip(resized_alpha, 0.0, 1.0).astype(np.float32)
    # Layer alpha equals the outer alpha wherever that layer owns a pixel.
    # Compare the two relatively so antialiased fringe pixels (for example
    # alpha=0.2, back=0.2) keep their ownership instead of being mistaken for
    # front merely because their absolute coverage is below 0.5.
    back_class = (a > 1e-6) & (b >= 0.5 * a)
    back_coverage = cv2.resize(
        back_class.astype(np.float32), size, interpolation=cv2.INTER_AREA)
    back_membership = back_coverage >= 0.5
    resized_back = (resized_alpha * back_membership).astype(np.float32)
    resized_front = (resized_alpha * ~back_membership).astype(np.float32)
    return resized_alpha, resized_front, resized_back


def reassign_front_specks(alpha, front, back, min_pixels=16,
                          support_threshold=0.0):
    """Move tiny disconnected front fragments into the back partition.

    These are normally isolated pixels along the band/head seam.  Leaving them
    in ``front.png`` makes short gold/white dashes float over the hand.  Moving
    rather than deleting them preserves ``front + back == full`` exactly.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    f = np.clip(np.asarray(front, np.float32), 0.0, 1.0).copy()
    b = np.clip(np.asarray(back, np.float32), 0.0, 1.0).copy()
    if min_pixels <= 1:
        return f, b
    threshold = max(0.0, float(support_threshold))
    solid = (f > threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    for i in range(1, count):
        if stats[i, cv2.CC_STAT_AREA] < int(min_pixels):
            move = labels == i
            f[move] = 0.0
            b[move] = a[move]
    return f, b


def scale_component_area(min_pixels, image_shape, reference_size=499):
    """Scale a component threshold with raster area.

    The native 1000px configurator render has four times as many pixels as its
    legacy 499px preview.  Without area scaling, the same floating seam dash
    stops qualifying as a speck merely because the source raster is larger.
    Never reduce the established threshold for smaller or unusual inputs.
    """
    height, width = image_shape[:2]
    scale = (min(height, width) / float(reference_size)) ** 2
    return max(int(min_pixels), int(round(float(min_pixels) * scale)))


def select_layer_actions(probability, threshold=0.5, class_thresholds=None,
                         min_component=0):
    """Turn four-class refiner probabilities into one discrete action map.

    The decision is intentionally made at the model's native resolution.
    Interpolating probabilities first and taking ``argmax`` afterwards can
    invent classes between neighbouring pixels, which previously introduced
    tiny front/back ownership defects in the production-sized output.
    """
    scores = np.asarray(probability, np.float32)
    if scores.ndim != 3 or scores.shape[0] != 4:
        raise ValueError("layer probabilities must have shape 4xHxW")
    confidence = scores.max(axis=0)
    choice = scores.argmax(axis=0).astype(np.uint8)
    if class_thresholds is None:
        required = np.full(choice.shape, float(threshold), np.float32)
    else:
        if len(class_thresholds) != 3:
            raise ValueError(
                "class thresholds must be background, front, back")
        thresholds = np.asarray((0.0, *map(float, class_thresholds)),
                                np.float32)
        required = thresholds[choice]
    choice[(choice != 0) & (confidence < required)] = 0

    minimum = int(min_component)
    if minimum <= 1:
        return choice
    filtered = np.zeros_like(choice)
    for action_class in (1, 2, 3):
        mask = (choice == action_class).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        for component in range(1, count):
            if int(stats[component, cv2.CC_STAT_AREA]) >= minimum:
                filtered[labels == component] = action_class
    return filtered


def resize_layer_actions(actions, bounds, image_shape):
    """Place a discrete crop action map into a native-resolution canvas."""
    labels = np.asarray(actions, np.uint8)
    if labels.ndim != 2:
        raise ValueError("layer action map must have shape HxW")
    y0, y1, x0, x1 = map(int, bounds)
    height, width = map(int, image_shape[:2])
    if not (0 <= y0 < y1 <= height and 0 <= x0 < x1 <= width):
        raise ValueError("layer action bounds escape the output canvas")
    native = np.zeros((height, width), np.uint8)
    native[y0:y1, x0:x1] = cv2.resize(
        labels, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
    return native


def separate_thin_back_bridge(alpha, front, back, max_thickness=6,
                              max_span_fraction=0.08, bgr=None,
                              texture_threshold=12.0,
                              texture_smooth_rows=3):
    """Round a narrow rear-mask bridge beneath a pointed front head.

    A large pear/cushion setting can fully occlude the lower band.  The back
    logit sometimes leaves a few bottom rows assigned to rear purely to connect
    the left and right band halves.  Its low-resolution seam becomes a blunt
    rectangular tab in ``front``.  Detect only that short central bridge and
    replace the step with a sinusoidal tip between the two thick band anchors.
    The rear band stays connected, the front tip tapers naturally, and the
    exact layer partition is preserved.  When the native source is available,
    the seam follows the transition from the textured head/halo to the smooth
    rear-band highlight.  This prevents a few smooth band rows from becoming
    a bright tab beneath a pear-shaped head.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    f = np.clip(np.asarray(front, np.float32), 0.0, 1.0).copy()
    b = np.clip(np.asarray(back, np.float32), 0.0, 1.0).copy()
    semantic = ((b > 0.0) & (a > 0.5)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(semantic, 8)
    if count <= 1:
        return f, b

    component_index = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    component = labels == component_index
    ys, xs = np.nonzero(component)
    if not len(xs):
        return f, b
    left, right = int(xs.min()), int(xs.max())
    span = right - left + 1
    if span < 8:
        return f, b

    scale = min(a.shape[:2]) / 499.0
    thickness_limit = max(1, int(round(float(max_thickness) * scale)))
    local_std = None
    if (bgr is not None and texture_threshold > 0 and
            np.asarray(bgr).shape[:2] == a.shape):
        gray = cv2.cvtColor(np.asarray(bgr, np.uint8),
                            cv2.COLOR_BGR2GRAY).astype(np.float32)
        mean = cv2.blur(gray, (5, 5))
        local_std = np.sqrt(np.maximum(
            cv2.blur(gray * gray, (5, 5)) - mean * mean, 0.0))
    thickness = np.array([int(component[:, x].sum())
                          for x in range(left, right + 1)])
    eligible = (thickness > 0) & (thickness <= thickness_limit)
    eligible[:span // 4] = False
    eligible[span - span // 4:] = False
    columns = np.flatnonzero(eligible)
    if not len(columns):
        return f, b

    max_span = max(3, int(round(span * float(max_span_fraction))))
    groups = np.split(columns, np.where(np.diff(columns) > 1)[0] + 1)
    front_solid = f > 0.5
    for group in groups:
        if not len(group) or len(group) > max_span:
            continue
        before, after = int(group[0]) - 1, int(group[-1]) + 1
        if before < 0 or after >= span:
            continue
        if min(thickness[before], thickness[after]) <= 2 * thickness_limit:
            continue

        supported_columns = 0
        for offset in group:
            x = left + int(offset)
            rows = np.flatnonzero(component[:, x])
            if not len(rows):
                continue
            top = int(rows.min())
            y0 = max(0, top - max(2, thickness_limit // 2))
            if front_solid[y0:top + 1, x].any():
                supported_columns += 1
        if supported_columns < max(1, int(np.ceil(0.75 * len(group)))):
            continue
        left_rows = np.flatnonzero(component[:, left + before])
        right_rows = np.flatnonzero(component[:, left + after])
        if not len(left_rows) or not len(right_rows):
            continue
        anchor_left = float(left_rows.min())
        anchor_right = float(right_rows.min())
        peak = max(float(np.flatnonzero(
            component[:, left + int(offset)]).min()) for offset in group)
        baseline_mid = 0.5 * (anchor_left + anchor_right)
        depth = max(0.0, peak - baseline_mid)
        if depth <= thickness_limit:
            continue

        desired_tops = []
        for position, offset in enumerate(group, start=1):
            x = left + int(offset)
            t = position / (len(group) + 1.0)
            baseline = anchor_left * (1.0 - t) + anchor_right * t
            desired_top = int(round(baseline + depth * np.sin(np.pi * t)))
            current_rows = np.flatnonzero(component[:, x])
            if local_std is not None:
                smooth_rows = max(2, int(texture_smooth_rows))
                search_start = max(1, int(np.floor(baseline)) - 2)
                search_end = min(
                    a.shape[0] - smooth_rows,
                    int(current_rows.max()) - smooth_rows + 1)
                transitions = []
                for row in range(search_start + 1, search_end + 1):
                    before_textured = (
                        local_std[row - 1, x] >= float(texture_threshold))
                    smooth_after = np.all(
                        local_std[row:row + smooth_rows, x] <
                        float(texture_threshold))
                    if before_textured and smooth_after:
                        transitions.append(row)
                if transitions:
                    source_top = transitions[-1]
                    # Source texture may prove that the geometric taper ran
                    # into the smooth rear band, so it may shorten the front
                    # tip.  It must never extend the front downward: doing so
                    # turns the curved geometry into a rectangular tab.
                    if (source_top < desired_top and
                            desired_top - source_top <= 2 * thickness_limit):
                        desired_top = int(source_top)
            desired_tops.append(desired_top)

        if len(desired_tops) >= 3:
            desired_tops = [
                int(round(np.median(
                    desired_tops[max(0, index - 2):index + 3])))
                for index in range(len(desired_tops))
            ]

        for offset, desired_top in zip(group, desired_tops):
            x = left + int(offset)
            current_rows = np.flatnonzero(component[:, x])
            current_top = int(current_rows.min())
            y0, y1 = min(current_top, desired_top), max(current_top, desired_top)
            rows = np.arange(y0, y1 + 1)
            ownership = a[y0:y1 + 1, x] > 0.0
            to_back = ownership & (rows >= desired_top)
            to_front = ownership & (rows < desired_top)
            target_front = f[y0:y1 + 1, x]
            target_back = b[y0:y1 + 1, x]
            target_back[to_back] = a[y0:y1 + 1, x][to_back]
            target_front[to_back] = 0.0
            target_front[to_front] = a[y0:y1 + 1, x][to_front]
            target_back[to_front] = 0.0
    return f, b


def repair_abrupt_front_tip(alpha, front, back, drop_ratio=0.45,
                            min_base_fraction=0.06,
                            max_base_fraction=0.60,
                            max_tip_fraction=0.04):
    """Replace a narrow rectangular ownership tab with a tapered head tip.

    When a pointed head overlaps the rear band, low-resolution ownership can
    make the central front run collapse abruptly from a broad pear/halo to a
    short rectangular bridge.  Detect that large one-row width drop near the
    bottom of the item and interpolate both sides from the last broad head row
    to the existing terminal row.  Pixels are only reassigned within ``alpha``;
    the full silhouette and exact partition remain unchanged.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    f = np.clip(np.asarray(front, np.float32), 0.0, 1.0).copy()
    b = np.clip(np.asarray(back, np.float32), 0.0, 1.0).copy()
    solid = a > 0.5
    front_solid = f > 0.5
    if not solid.any() or not front_solid.any():
        return f, b

    ys, xs = np.nonzero(solid)
    item_width = int(xs.max() - xs.min() + 1)
    item_height = int(ys.max() - ys.min() + 1)
    centre = 0.5 * (float(xs.min()) + float(xs.max()))
    centre_x = int(round(centre))
    min_base = float(min_base_fraction) * item_width
    max_tip_length = max(3, int(round(float(max_tip_fraction) * item_width)))
    search_start = int(round(float(ys.min()) + 0.55 * item_height))

    runs = {}
    for row in range(search_start, int(ys.max()) + 1):
        columns = np.flatnonzero(front_solid[row])
        if not len(columns):
            continue
        groups = np.split(columns, np.where(np.diff(columns) > 1)[0] + 1)
        central = [group for group in groups if len(group) and
                   int(group[0]) <= centre_x <= int(group[-1])]
        if central:
            group = central[0]
            runs[row] = (int(group[0]), int(group[-1]))

    for anchor_row in sorted(runs):
        next_row = anchor_row + 1
        if next_row not in runs:
            continue
        anchor_left, anchor_right = runs[anchor_row]
        next_left, next_right = runs[next_row]
        anchor_width = anchor_right - anchor_left + 1
        next_width = next_right - next_left + 1
        # A pointed setting is a central feature.  On double/split shanks the
        # two shoulders can join through the head and form one almost
        # full-width run before dropping to the lower halo.  Treating that as
        # a pointed tip reassigns an entire shoulder rail to the rear layer.
        # The real pear/marquise tips this repair targets occupy a small
        # fraction of the ring width (roughly 0.11--0.16 in the regression
        # set), while the false shoulder trigger is about 0.99.
        if (anchor_width < min_base or
                anchor_width > float(max_base_fraction) * item_width or
                next_width > float(drop_ratio) * anchor_width):
            continue

        tip_end = next_row
        previous_width = next_width
        while tip_end + 1 in runs and tip_end - anchor_row < max_tip_length:
            candidate_left, candidate_right = runs[tip_end + 1]
            candidate_width = candidate_right - candidate_left + 1
            # A terminal tab/taper cannot widen substantially after the drop.
            if candidate_width > previous_width + 3:
                break
            tip_end += 1
            previous_width = candidate_width
        if tip_end - anchor_row < 3:
            continue

        terminal_left, terminal_right = runs[tip_end]
        tip_centre = 0.5 * (terminal_left + terminal_right)
        affected = np.zeros_like(solid)
        affected[anchor_row + 1:tip_end + 1,
                 anchor_left:anchor_right + 1] = True
        target = np.zeros_like(solid)
        length = float(tip_end - anchor_row)
        for row in range(anchor_row + 1, tip_end + 1):
            t = (row - anchor_row) / length
            left = int(round(anchor_left * (1.0 - t) + tip_centre * t))
            right = int(round(anchor_right * (1.0 - t) + tip_centre * t))
            if right < left:
                left, right = right, left
            target[row, max(left, 0):min(right + 1, solid.shape[1])] = True
        target &= solid & affected

        to_front = target
        to_back = affected & solid & ~target
        f[to_front] = a[to_front]
        b[to_front] = 0.0
        b[to_back] = a[to_back]
        f[to_back] = 0.0
        return f, b
    return f, b


def reassign_back_specks(alpha, front, back, min_pixels=300,
                         keep_largest=True, allow_occluded_band=True,
                         preserve_aligned_details=False):
    """Move every detached back fragment into the front partition.

    The try-on layer contract has one rear object: the continuous lower band.
    Prongs, shoulder supports, highlights and other detached pieces above it
    belong to the front even when they are individually larger than the old
    speck threshold.  Keep only the largest connected back component by
    default.  Moving rather than deleting rejected pixels preserves both the
    full silhouette and ``front + back == full`` exactly.

    A genuine front occluder can split that same rear object into two large,
    horizontally aligned visible halves.  When ``allow_occluded_band`` is
    true, retain one such lower-band mate; small/high support rails still move
    to front.  Some halo designs also have three or more repeated lower
    prong/petal tips behind the hand.  ``preserve_aligned_details`` retains
    only a compact, horizontally distributed row of those details.  It is
    opt-in so the native reviewed-correction contract remains unchanged.
    ``min_pixels`` remains available for diagnostic callers that explicitly
    disable ``keep_largest`` and as the minimum aligned-detail area.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    f = np.clip(np.asarray(front, np.float32), 0.0, 1.0).copy()
    b = np.clip(np.asarray(back, np.float32), 0.0, 1.0).copy()
    if min_pixels <= 1:
        return f, b
    ownership = b > 0.0
    # Component semantics follow the opaque item, not nonzero antialias
    # support.  A one-pixel translucent bridge can otherwise make a detached
    # rail appear connected to the lower band even though the serialized
    # >50% mask still contains two objects.
    semantic = (ownership & (a > 0.5)).astype(np.uint8)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        semantic, 8)
    if count <= 1:
        return f, b
    areas = {i: int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, count)}
    if keep_largest and areas:
        retained_index = max(areas, key=areas.get)
        retained = {retained_index}
        if allow_occluded_band and len(areas) > 1:
            main = stats[retained_index]
            main_left = int(main[cv2.CC_STAT_LEFT])
            main_right = main_left + int(main[cv2.CC_STAT_WIDTH]) - 1
            main_top = int(main[cv2.CC_STAT_TOP])
            main_bottom = main_top + int(main[cv2.CC_STAT_HEIGHT]) - 1
            best = None
            for index, area in areas.items():
                if index == retained_index or area < 0.35 * areas[retained_index]:
                    continue
                candidate = stats[index]
                left = int(candidate[cv2.CC_STAT_LEFT])
                right = left + int(candidate[cv2.CC_STAT_WIDTH]) - 1
                top = int(candidate[cv2.CC_STAT_TOP])
                bottom = top + int(candidate[cv2.CC_STAT_HEIGHT]) - 1
                vertical_overlap = max(0, min(main_bottom, bottom) -
                                       max(main_top, top) + 1)
                minimum_height = min(int(main[cv2.CC_STAT_HEIGHT]),
                                     int(candidate[cv2.CC_STAT_HEIGHT]))
                separated = right < main_left or left > main_right
                bottom_delta = abs(bottom - main_bottom)
                aligned_bottom = bottom_delta <= max(
                    3, int(round(min(a.shape[:2]) * 8.0 / 499.0)))
                # A large setting can hide different amounts of the two rear
                # halves, so their bounding-box bottoms need not align.  Their
                # vertical centres still track the same band sweep.  This is
                # the perspective case seen on the 10 ct marquise: the halves
                # differ by 35 px at the bottom but their centroids differ by
                # less than one pixel.
                centre_delta = abs(float(centroids[index, 1]) -
                                   float(centroids[retained_index, 1]))
                aligned_midline = centre_delta <= max(
                    3.0, 0.25 * float(minimum_height))
                # Perspective and a large head can leave one visible band
                # half slightly taller than it is wide.  Requiring a 1.5
                # aspect ratio rejected a genuine 56x38 mate (1.47) and left
                # only the opposite half in the API response.  Keep the
                # shape guard, but allow the small perspective tolerance;
                # the alignment, separation, overlap and area checks above
                # still reject detached prongs/supports.
                band_like = (int(candidate[cv2.CC_STAT_WIDTH]) >=
                             1.4 * int(candidate[cv2.CC_STAT_HEIGHT]))
                if (separated and (aligned_bottom or aligned_midline) and
                        band_like and
                        vertical_overlap >= 0.5 * minimum_height):
                    score = (vertical_overlap / max(minimum_height, 1), area)
                    if best is None or score > best[0]:
                        best = (score, index)
            if best is not None:
                retained.add(best[1])

        if preserve_aligned_details and len(areas) >= 4:
            item_y, item_x = np.nonzero(a > 0.5)
            if len(item_x):
                item_width = int(np.ptp(item_x) + 1)
                item_height = int(np.ptp(item_y) + 1)
                centre_x = 0.5 * (float(item_x.min()) + float(item_x.max()))
                baseline_y = max(float(centroids[index, 1])
                                 for index in retained)
                maximum_area = 0.35 * float(areas[retained_index])
                maximum_height = max(3, int(round(0.12 * item_height)))
                vertical_tolerance = max(4.0, 0.04 * float(item_height))
                candidates = []
                for index, area in areas.items():
                    if index in retained or not (
                            int(min_pixels) <= area <= maximum_area):
                        continue
                    component_height = int(
                        stats[index, cv2.CC_STAT_HEIGHT])
                    if component_height > maximum_height:
                        continue
                    x = float(centroids[index, 0])
                    y = float(centroids[index, 1])
                    if y < baseline_y - vertical_tolerance:
                        continue
                    candidates.append((y, x, index))

                # Select a horizontal row rather than accepting isolated
                # components one by one.  A real halo rail repeats across the
                # centre; random ownership noise does not form that pattern.
                candidates.sort()
                best_group = None
                for start in range(len(candidates)):
                    group = []
                    anchor_y = candidates[start][0]
                    for candidate in candidates[start:]:
                        if candidate[0] - anchor_y > vertical_tolerance:
                            break
                        group.append(candidate)
                    if len(group) < 3:
                        continue
                    left = min(value[1] for value in group)
                    right = max(value[1] for value in group)
                    span = right - left
                    crosses_centre = (
                        left <= centre_x - 0.05 * item_width and
                        right >= centre_x + 0.05 * item_width)
                    if span < 0.15 * item_width or not crosses_centre:
                        continue
                    score = (len(group), span)
                    if best_group is None or score > best_group[0]:
                        best_group = (score, group)
                if best_group is not None:
                    retained.update(value[2] for value in best_group[1])

        retained_solid = np.isin(labels, list(retained))
        # Retain only the subpixel fringe immediately surrounding the chosen
        # solid component(s).  Opaque pixels from any other component must move
        # to front even if a translucent bridge touches the band.
        near_retained = cv2.dilate(
            retained_solid.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        keep = retained_solid | (ownership & (a <= 0.5) & near_retained)
        move = ownership & ~keep
        b[move] = 0.0
        f[move] = a[move]

        # Do not leave a detached translucent dash merely because it lies
        # within the dilation radius of the retained solid band.  Serialized
        # PNGs expose any non-zero alpha on a dark background, so retain only
        # non-zero-alpha components that actually contain one of the accepted
        # solid rear components.
        support = (b > 0.0).astype(np.uint8)
        support_count, support_labels = cv2.connectedComponents(support, 8)
        if support_count > 1:
            accepted_support = np.unique(support_labels[retained_solid])
            accepted_support = accepted_support[accepted_support > 0]
            detached = (b > 0.0) & ~np.isin(
                support_labels, accepted_support)
            b[detached] = 0.0
            f[detached] = a[detached]
        return f, b
    else:
        retained = {i for i, area in areas.items() if area >= int(min_pixels)}
    for i in range(1, count):
        if i not in retained:
            move = labels == i
            b[move] = 0.0
            f[move] = a[move]
    return f, b


def regularize_back_band(alpha, front, back, window=41, max_depth=10):
    """Close narrow downward notches in the continuous rear-band top edge.

    Large heads sometimes suppress the back logit exactly where the lower
    shank passes beneath them.  That leaves a small tooth of band material in
    ``front.png`` even though the rear object itself remains connected.  A
    one-dimensional opening estimates the smooth top envelope of the largest
    back component and transfers only existing full-matte pixels across the
    seam.  The bounded depth protects intentional large occlusions.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    f = np.clip(np.asarray(front, np.float32), 0.0, 1.0).copy()
    b = np.clip(np.asarray(back, np.float32), 0.0, 1.0).copy()
    semantic = ((b > 0.0) & (a > 0.5)).astype(np.uint8)
    count, component_labels, stats, _ = cv2.connectedComponentsWithStats(
        semantic, 8)
    if count <= 1:
        return f, b
    component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    solid = component_labels == component
    ys, xs = np.nonzero(solid)
    if not len(xs):
        return f, b

    left, right = int(xs.min()), int(xs.max())
    span = right - left + 1
    scaled_window = max(3, int(round(float(window) *
                                     min(a.shape[:2]) / 499.0)))
    scaled_window = min(scaled_window | 1, span if span % 2 else span - 1)
    scaled_depth = max(1, int(round(float(max_depth) *
                                    min(a.shape[:2]) / 499.0)))
    if scaled_window < 3 or span < scaled_window:
        return f, b

    top = np.full(span, a.shape[0], np.float32)
    for offset, x in enumerate(range(left, right + 1)):
        column = np.flatnonzero(solid[:, x])
        if len(column):
            top[offset] = float(column.min())
    valid = top < a.shape[0]
    if not valid.all():
        known = np.flatnonzero(valid)
        if len(known) < scaled_window:
            return f, b
        top = np.interp(np.arange(span), known, top[known]).astype(np.float32)

    envelope = cv2.morphologyEx(
        top.reshape(1, -1), cv2.MORPH_OPEN,
        np.ones((1, scaled_window), np.uint8)).reshape(-1)
    # Ignore the outer quarter where the band naturally turns upward into the
    # shoulders.  The failure this targets is beneath the centre setting.
    focus_left, focus_right = span // 4, span - span // 4
    proposed = np.zeros_like(solid)
    for offset in range(focus_left, focus_right):
        delta = int(round(top[offset] - envelope[offset]))
        if delta <= 0 or delta > scaled_depth:
            continue
        x = left + offset
        y0 = max(0, int(round(envelope[offset])))
        y1 = min(a.shape[0], int(round(top[offset])))
        move = a[y0:y1, x] > 0.0
        if move.any():
            proposed[y0:y1, x][move] = True

    # A central notch may be intentional: the front-facing point of a
    # marquise/pear/halo can overlap the rear band.  If the pixels proposed for
    # reassignment are supported by a substantial front component immediately
    # above them, keep that head tip in front.  An unsupported notch entirely
    # inside the band is still regularized.
    proposal_count, proposal_labels, proposal_stats, _ = (
        cv2.connectedComponentsWithStats(proposed.astype(np.uint8), 8))
    centre_x = int(round(0.5 * (left + right)))
    front_solid = f > 0.5
    for index in range(1, proposal_count):
        x0 = int(proposal_stats[index, cv2.CC_STAT_LEFT])
        y0 = int(proposal_stats[index, cv2.CC_STAT_TOP])
        width = int(proposal_stats[index, cv2.CC_STAT_WIDTH])
        x1 = x0 + width
        crosses_centre = x0 <= centre_x < x1
        above_y0 = max(0, y0 - scaled_depth)
        supported = 0.0
        if y0 > above_y0 and width > 0:
            supported = float(np.mean(np.any(
                front_solid[above_y0:y0, x0:x1], axis=0)))
        if crosses_centre and supported >= 0.5:
            continue
        move = proposal_labels == index
        b[move] = a[move]
        f[move] = 0.0
    return f, b


def to_rgba(bgr_fg, alpha):
    # Round rather than truncate: Gaussian filtering can represent an opaque
    # interior as 0.99999994, which must still serialize as alpha 255.
    encoded_alpha = np.rint(np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    return np.dstack([bgr_fg, encoded_alpha])


def veto_background(alpha, bgr, background=None, tol=6.0, min_component=0.002):
    """Remove matte pixels that are provably background.

    The model is semantic, not pixel-exact: it will extend a few pixels into
    empty space and occasionally invent an isolated speck. The source image can
    veto those, but only where the veto is safe. A pixel is deleted when its
    colour matches the background *and* it is reachable from the image border
    through other background-coloured pixels. That reachability test is what
    protects white stones - they match the background too, but are enclosed by
    the item, so the flood never gets to them.

    Finally, components far smaller than the item are dropped outright.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    if background is None:
        background = estimate_background(bgr)

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg_lab = cv2.cvtColor(background.reshape(1, 1, 3).astype(np.uint8),
                          cv2.COLOR_BGR2LAB).astype(np.float32).reshape(3)
    flat = (np.linalg.norm(lab - bg_lab[None, None, :], axis=2) < tol).astype(np.uint8)

    # flood the flat region inward from the border; whatever it reaches is outside
    h, w = flat.shape
    ff = flat.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if flat[seed[1], seed[0]]:
            cv2.floodFill(ff, mask, seed, 2)
    outside = ff == 2
    a[outside] = 0.0

    solid = (a > 0.5).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    if count > 1:
        areas = stats[1:, cv2.CC_STAT_AREA]
        biggest = areas.max()
        for i, ar in enumerate(areas, start=1):
            if ar < min_component * biggest or ar < 0.02 * biggest:
                a[labels == i] = 0.0
    return a


def veto_enclosed_background(alpha, bgr, background=None, colour_tol=6.0,
                             texture_tol=2.0, seed_alpha=0.1):
    """Remove flat canvas slivers along enclosed openings in the jewellery.

    :func:`veto_background` deliberately floods only from the image border so
    that a pale gemstone is not mistaken for a white canvas.  That leaves one
    blind spot: background inside a ring opening is enclosed by metal.  If the
    predicted matte spills over the edge of that opening, its white shelf is
    disconnected from the outer border and survives the ordinary veto.

    Here every confidently negative matte region can seed the flood, including
    holes.  Eligibility is intentionally much stricter than a colour key: a
    pixel must both match the estimated canvas and be nearly textureless in a
    5x5 neighbourhood.  Faceted stones therefore interrupt the flood even when
    one of their individual pixels is white.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0).copy()
    if colour_tol <= 0 or texture_tol <= 0:
        return a
    if background is None:
        background = estimate_background(bgr)

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg_lab = cv2.cvtColor(background.reshape(1, 1, 3).astype(np.uint8),
                          cv2.COLOR_BGR2LAB).astype(np.float32).reshape(3)
    colour_distance = np.linalg.norm(lab - bg_lab[None, None, :], axis=2)

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mean = cv2.blur(gray, (5, 5))
    variance = cv2.blur(gray * gray, (5, 5)) - mean * mean
    local_std = np.sqrt(np.maximum(variance, 0.0))
    eligible = ((colour_distance < float(colour_tol)) &
                (local_std < float(texture_tol))).astype(np.uint8)

    count, labels = cv2.connectedComponents(eligible, 8)
    if count <= 1:
        return a
    seeded = np.unique(labels[a < float(seed_alpha)])
    seeded = seeded[seeded != 0]
    if len(seeded):
        a[np.isin(labels, seeded)] = 0.0
    return a


def fill_metal_holes(alpha, bgr, background=None, max_frac=0.02, tol=8.0):
    """Close small holes the model punched through solid metal.

    Only holes that are both small relative to the item *and* sit on
    non-background source pixels are filled, which leaves the finger opening
    (large, and background-coloured) untouched.
    """
    a = np.clip(np.asarray(alpha, np.float32), 0.0, 1.0)
    solid = (a > 0.5).astype(np.uint8)
    if not solid.any():
        return a
    if background is None:
        background = estimate_background(bgr)

    h, w = solid.shape
    ff = (1 - solid).astype(np.uint8)
    for seed in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), seed, 0)

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg_lab = cv2.cvtColor(background.reshape(1, 1, 3).astype(np.uint8),
                          cv2.COLOR_BGR2LAB).astype(np.float32).reshape(3)
    dist = np.linalg.norm(lab - bg_lab[None, None, :], axis=2)

    area = solid.sum()
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ff, 8)
    for i in range(1, count):
        if stats[i, cv2.CC_STAT_AREA] > max_frac * area:
            continue                                   # the finger opening
        m = labels == i
        if dist[m].mean() > tol:                       # real material, not background
            a[m] = 1.0
    return a
