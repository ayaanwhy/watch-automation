"""Run the trained segmenter on product images.

    python -m vto.predict --ckpt vto/runs/base/best.pt rings/ --outdir output/model
"""

import argparse
import glob
import os

import cv2
import numpy as np
import torch
import torch.nn.functional as F

from vto.model import model_from_checkpoint
from vto.refiner import MatteRefiner
from vto.post import (antialias_subpixel, clean_gem_silhouette, decontaminate,
                      fill_metal_holes,
                      refine_plain_background_contour, regularize_back_band,
                      recover_plain_background_edges,
                      repair_abrupt_front_tip, repair_shoulder_slits,
                      repair_upper_ring_opening,
                      separate_thin_back_bridge,
                      reassign_back_specks, reassign_front_specks,
                      remove_alpha_specks, scale_component_area, sharpen_alpha,
                      split_layers, to_rgba,
                      trim_background_edge, veto_background,
                      veto_enclosed_background)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("images", nargs="+")
    p.add_argument("--ckpt", default="vto/runs/base/best.pt")
    p.add_argument("--refiner", default="",
                   help="optional matte-only refiner checkpoint; the v6 back "
                        "prediction and first-pass crop remain unchanged")
    p.add_argument("--outdir", default="output/model")
    p.add_argument("--parent-name", action="store_true",
                   help="name each output from its parent directory (useful for source.jpg sets)")
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    p.add_argument("--thr", type=float, default=0.5)
    p.add_argument("--matte-thr", type=float, default=0.5,
                   help="matte threshold used to locate/count the item; --thr controls back")
    p.add_argument("--back-expand", type=int, default=1,
                   help="pixels assigned to back around the occlusion seam")
    p.add_argument("--sharpen", type=float, default=6.0,
                   help="alpha contrast; 0 disables. 6 matches the hardness of "
                        "the retouched source assets")
    p.add_argument("--edge-trim", type=float, default=1.5,
                   help="source pixels at the inner contour eligible for background cleanup")
    p.add_argument("--edge-color-tol", type=float, default=12.0,
                   help="Lab distance used to estimate alpha in the narrow edge trim")
    p.add_argument("--edge-texture-tol", type=float, default=18.0,
                   help="protect textured stone edges from the flat-canvas trim")
    p.add_argument("--min-alpha-component", type=int, default=32,
                   help="remove smaller disconnected components from encoded alpha")
    p.add_argument("--min-back-component", type=int, default=300,
                   help="move smaller detached back-layer fragments into the front")
    p.add_argument("--antialias", type=float, default=0.6,
                   help="subpixel contour smoothing sigma; 0 disables")
    p.add_argument("--edge-feather", type=float, default=0.85,
                   help="softness of the inward antialiased edge")
    p.add_argument("--source-refine-radius", type=int, default=4,
                   help="native pixels around a uniform-canvas ring matte "
                        "eligible for source-guided contour recovery")
    p.add_argument("--source-refine-iterations", type=int, default=1,
                   help="GrabCut iterations for source-guided ring recovery; "
                        "0 disables")
    p.add_argument("--opening-smooth-window", type=int, default=41,
                   help="reference-pixel window used to repair narrow upper "
                        "finger-opening notches")
    p.add_argument("--opening-smooth-depth", type=int, default=15,
                   help="maximum reference-pixel finger-opening notch depth")
    p.add_argument("--source-edge-radius", type=int, default=6,
                   help="reference-pixel shoulder band searched for attached "
                        "native source edges")
    p.add_argument("--source-edge-color-tol", type=float, default=8,
                   help="Lab distance from a uniform canvas required for "
                        "source-edge recovery")
    p.add_argument("--back-smooth-window", type=int, default=41,
                   help="reference-pixel window used to close narrow rear-band notches")
    p.add_argument("--back-smooth-depth", type=int, default=10,
                   help="maximum reference-pixel rear-band notch depth")
    p.add_argument("--back-bridge-thickness", type=int, default=6,
                   help="maximum reference-pixel thin rear bridge moved under "
                        "a front occluder")
    p.add_argument("--no-veto", action="store_true",
                   help="skip the background veto (keeps model-invented specks)")
    p.add_argument("--veto-tol", type=float, default=2.0,
                   help="Lab distance under which a pixel counts as background")
    p.add_argument("--gem-veto-tol", type=float, default=6.0,
                   help="stronger plain-background veto for --gemstone")
    p.add_argument("--gem-edge-erode", type=int, default=1,
                   help="source pixels removed from the loose-gem contour")
    p.add_argument("--enclosed-veto-tol", type=float, default=6.0,
                   help="Lab tolerance for flat canvas inside ring openings; 0 disables")
    p.add_argument("--enclosed-texture-tol", type=float, default=2.0,
                   help="maximum local intensity deviation for enclosed canvas cleanup")
    p.add_argument("--no-decontaminate", action="store_true",
                   help="keep the raw RGB (edges will fringe on dark backgrounds)")
    p.add_argument("--pad", type=float, default=0.02,
                   help="margin around the detected ring on the second pass; "
                        "training crops were tight, so keep this small")
    p.add_argument("--gemstone", action="store_true",
                   help="matte-only single gemstone: front=full and back is empty")
    return p.parse_args()


def expand(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            for e in ("jpg", "jpeg", "png", "webp"):
                out += sorted(glob.glob(os.path.join(p, f"*.{e}")))
        else:
            out += sorted(glob.glob(p)) or [p]
    return out


def output_name(path, parent_name=False):
    if parent_name:
        return os.path.basename(os.path.dirname(os.path.abspath(path)))
    return os.path.splitext(os.path.basename(path))[0]


@torch.no_grad()
def main():
    args = parse_args()
    ck = torch.load(args.ckpt, map_location="cpu")
    size = ck.get("size", 384)
    model = model_from_checkpoint(ck).to(args.device).eval()
    refiner = None
    refiner_size = None
    if args.refiner:
        rc = torch.load(args.refiner, map_location="cpu", weights_only=False)
        refiner_size = int(rc.get("size", 512))
        refiner = MatteRefiner(rc.get("band_radius", 8)).to(args.device).eval()
        refiner.load_state_dict(rc["refiner"])
    print(f"[i] {args.ckpt}  size={size}  val back IoU={ck.get('back_iou', float('nan')):.3f}")
    if refiner is not None:
        print(f"[i] {args.refiner}  matte-only size={refiner_size}  "
              f"epoch={rc.get('epoch', '?')}")

    def infer(img, refine=True):
        x = cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        t = torch.from_numpy(x.transpose(2, 0, 1))[None].to(args.device)
        logits = model(t)
        hh, ww = img.shape[:2]
        # The back layer always follows the original v6 path directly from its
        # native resolution to the source image.  Only the matte is refined.
        back = cv2.resize(torch.sigmoid(logits[0, 1]).cpu().numpy(), (ww, hh),
                          interpolation=cv2.INTER_LINEAR)
        if refiner is None or not refine:
            matte = cv2.resize(torch.sigmoid(logits[0, 0]).cpu().numpy(), (ww, hh),
                               interpolation=cv2.INTER_LINEAR)
            return matte, back
        high = cv2.resize(img, (refiner_size, refiner_size),
                          interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
        high = torch.from_numpy(high.transpose(2, 0, 1))[None].to(args.device)
        coarse = F.interpolate(logits[:, :1], size=(refiner_size, refiner_size),
                               mode="bilinear", align_corners=False)
        matte = torch.sigmoid(refiner(high, coarse))[0, 0].cpu().numpy()
        return (cv2.resize(matte, (ww, hh), interpolation=cv2.INTER_LINEAR), back)

    for path in expand(args.images):
        raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if raw is None:
            continue
        bgr = raw[..., :3] if raw.ndim == 3 and raw.shape[2] == 4 else raw
        h, w = bgr.shape[:2]

        # Training crops are tight to the ring, so a loosely framed product shot
        # must be cropped the same way or the model sees it at the wrong scale.
        # Locate the crop with unmodified v6. A refined first pass could move
        # the crop by a pixel and indirectly perturb v6's semantic prediction.
        a0, b0 = infer(bgr, refine=False)
        ys, xs = np.nonzero(a0 > args.matte_thr)
        alpha = np.zeros((h, w), np.float32)
        back = np.zeros((h, w), np.float32)
        if len(xs):
            pad = int(args.pad * max(xs.ptp() + 1, ys.ptp() + 1))
            y0, y1 = max(ys.min() - pad, 0), min(ys.max() + 1 + pad, h)
            x0, x1 = max(xs.min() - pad, 0), min(xs.max() + 1 + pad, w)
            ca, cb = infer(bgr[y0:y1, x0:x1])
            alpha[y0:y1, x0:x1] = ca
            back[y0:y1, x0:x1] = cb
        else:
            alpha, back = a0, b0

        if not args.no_veto:
            alpha = veto_background(
                alpha, bgr,
                tol=args.gem_veto_tol if args.gemstone else args.veto_tol)
            alpha = fill_metal_holes(alpha, bgr)
            alpha = repair_shoulder_slits(alpha)
            alpha = veto_enclosed_background(
                alpha, bgr, colour_tol=args.enclosed_veto_tol,
                texture_tol=args.enclosed_texture_tol)
        alpha = sharpen_alpha(alpha, args.sharpen) if args.sharpen else alpha
        alpha = trim_background_edge(alpha, bgr, radius=args.edge_trim,
                                     tol=args.edge_color_tol,
                                     texture_tol=args.edge_texture_tol)
        if not args.gemstone:
            alpha = refine_plain_background_contour(
                alpha, bgr, radius=args.source_refine_radius,
                iterations=args.source_refine_iterations)
            alpha = repair_upper_ring_opening(
                alpha, window=args.opening_smooth_window,
                max_depth=args.opening_smooth_depth)
            alpha = recover_plain_background_edges(
                alpha, bgr, radius=args.source_edge_radius,
                colour_tol=args.source_edge_color_tol)
            alpha = fill_metal_holes(alpha, bgr)
        alpha = remove_alpha_specks(
            alpha, min_pixels=args.min_alpha_component,
            keep_largest=args.gemstone)
        if args.gemstone:
            alpha = clean_gem_silhouette(
                alpha, bgr=bgr, erode=args.gem_edge_erode)
            alpha = remove_alpha_specks(alpha, keep_largest=True)
        alpha = antialias_subpixel(alpha, sigma=args.antialias,
                                   edge_sigma=args.edge_feather)
        if args.gemstone:
            alpha = remove_alpha_specks(alpha, keep_largest=True)
        if args.gemstone:
            a, f, b = alpha, alpha.copy(), np.zeros_like(alpha)
        else:
            a, f, b = split_layers(alpha, back, args.thr, sharpen=0,
                                   expand=args.back_expand)
            f, b = regularize_back_band(
                a, f, b, window=args.back_smooth_window,
                max_depth=args.back_smooth_depth)
            f, b = separate_thin_back_bridge(
                a, f, b, max_thickness=args.back_bridge_thickness, bgr=bgr)
            f, b = repair_abrupt_front_tip(a, f, b)
            f, b = reassign_front_specks(
                a, f, b, min_pixels=scale_component_area(16, bgr.shape))
            f, b = reassign_back_specks(
                a, f, b, min_pixels=scale_component_area(
                    args.min_back_component, bgr.shape))
        fg = bgr if args.no_decontaminate else decontaminate(bgr, a)

        name = output_name(path, args.parent_name)
        d = os.path.join(args.outdir, name)
        os.makedirs(d, exist_ok=True)
        for lab, m in (("full", a), ("front", f), ("back", b)):
            cv2.imwrite(os.path.join(d, f"{lab}.png"), to_rgba(fg, m))
        print(f"[✓] {name:<24} full={int((a>args.matte_thr).sum()):7d} "
              f"back={int((b>args.thr).sum()):7d}")


if __name__ == "__main__":
    main()
