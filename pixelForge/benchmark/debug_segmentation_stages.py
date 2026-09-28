#!/usr/bin/env python3
"""Render every ring-matte cleanup stage for a native source image."""

import argparse
from pathlib import Path

import cv2
import numpy as np

from benchmark.build_manual_review import fit_tile, labelled
from deploy import serve
from vto.post import (antialias_subpixel, fill_metal_holes,
                      refine_plain_background_contour, regularize_back_band,
                      recover_plain_background_edges,
                      repair_abrupt_front_tip, repair_shoulder_slits,
                      repair_upper_ring_opening,
                      separate_thin_back_bridge,
                      reassign_back_specks, reassign_front_specks,
                      remove_alpha_specks, scale_component_area,
                      sharpen_alpha, split_layers, trim_background_edge,
                      veto_background, veto_enclosed_background)


def heatmap(mask):
    colour = cv2.applyColorMap(np.clip(mask * 255, 0, 255).astype(np.uint8),
                               cv2.COLORMAP_TURBO)
    colour[mask <= 0.01] = 31
    return colour


def masked_source(source, mask):
    alpha = mask[..., None].astype(np.float32)
    return np.clip(source * alpha + 31 * (1 - alpha), 0, 255).astype(np.uint8)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--output", required=True)
    parser.add_argument("--tile", type=int, default=420)
    args = parser.parse_args()

    source_path = Path(args.source).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    bgr = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"could not read {source_path}")

    raw, raw_back = serve._predict_crop(bgr)
    stages = [("raw probability", raw.copy())]
    alpha = veto_background(raw, bgr, tol=serve.VETO_TOL)
    stages.append(("background veto", alpha.copy()))
    alpha = fill_metal_holes(alpha, bgr)
    stages.append(("metal holes", alpha.copy()))
    alpha = veto_enclosed_background(
        alpha, bgr, colour_tol=serve.ENCLOSED_VETO_TOL,
        texture_tol=serve.ENCLOSED_TEXTURE_TOL)
    stages.append(("enclosed veto", alpha.copy()))
    alpha = sharpen_alpha(alpha, serve.SHARPEN) if serve.SHARPEN else alpha
    stages.append(("sharpen", alpha.copy()))
    alpha = trim_background_edge(
        alpha, bgr, radius=serve.EDGE_TRIM, tol=serve.EDGE_COLOR_TOL,
        texture_tol=serve.EDGE_TEXTURE_TOL)
    stages.append(("edge trim", alpha.copy()))
    alpha = refine_plain_background_contour(
        alpha, bgr, radius=serve.SOURCE_REFINE_RADIUS,
        iterations=serve.SOURCE_REFINE_ITERATIONS)
    stages.append(("source contour", alpha.copy()))
    alpha = repair_upper_ring_opening(
        alpha, window=serve.OPENING_SMOOTH_WINDOW,
        max_depth=serve.OPENING_SMOOTH_DEPTH)
    stages.append(("ring opening", alpha.copy()))
    alpha = veto_enclosed_background(
        alpha, bgr, colour_tol=serve.ENCLOSED_VETO_TOL,
        texture_tol=serve.ENCLOSED_TEXTURE_TOL)
    stages.append(("post-repair background veto", alpha.copy()))
    alpha = recover_plain_background_edges(
        alpha, bgr, radius=serve.SOURCE_EDGE_RADIUS,
        colour_tol=serve.SOURCE_EDGE_COLOR_TOL)
    stages.append(("source edge lines", alpha.copy()))
    alpha = fill_metal_holes(alpha, bgr)
    stages.append(("late metal holes", alpha.copy()))
    alpha = repair_shoulder_slits(alpha)
    stages.append(("shoulder slits", alpha.copy()))
    alpha = remove_alpha_specks(alpha,
                                min_pixels=serve.MIN_ALPHA_COMPONENT)
    stages.append(("component cleanup", alpha.copy()))
    alpha = antialias_subpixel(alpha, sigma=serve.ANTIALIAS,
                               edge_sigma=serve.EDGE_FEATHER)
    stages.append(("final alpha", alpha.copy()))
    full, front, back = split_layers(alpha, raw_back, serve.BACK_THR,
                                     sharpen=0, expand=serve.BACK_EXPAND)
    front, back = regularize_back_band(
        full, front, back, window=serve.BACK_SMOOTH_WINDOW,
        max_depth=serve.BACK_SMOOTH_DEPTH)
    front, back = separate_thin_back_bridge(
        full, front, back, max_thickness=serve.BACK_BRIDGE_THICKNESS,
        bgr=bgr)
    front, back = repair_abrupt_front_tip(full, front, back)
    pre_front = front.copy()
    pre_back = back.copy()
    front_min = scale_component_area(16, bgr.shape)
    back_min = scale_component_area(serve.MIN_BACK_COMPONENT, bgr.shape)
    front, back = reassign_front_specks(full, front, back,
                                        min_pixels=front_min)
    front, back = reassign_back_specks(full, front, back,
                                       min_pixels=back_min)

    for index, (name, mask) in enumerate(stages):
        cv2.imwrite(str(output / f"{index:02d}-{name.replace(' ', '-')}.png"),
                    np.clip(mask * 255, 0, 255).astype(np.uint8))
    cv2.imwrite(str(output / "source.png"), bgr)
    cv2.imwrite(str(output / "final-front.png"),
                np.clip(front * 255, 0, 255).astype(np.uint8))
    cv2.imwrite(str(output / "final-back.png"),
                np.clip(back * 255, 0, 255).astype(np.uint8))
    cv2.imwrite(str(output / "raw-back-probability.png"),
                np.clip(raw_back * 255, 0, 255).astype(np.uint8))
    cv2.imwrite(str(output / "pre-reassign-front.png"),
                np.clip(pre_front * 255, 0, 255).astype(np.uint8))
    cv2.imwrite(str(output / "pre-reassign-back.png"),
                np.clip(pre_back * 255, 0, 255).astype(np.uint8))

    panels = [labelled(fit_tile(bgr, args.tile), "source")]
    for name, mask in stages:
        panels.append(labelled(fit_tile(masked_source(bgr, mask), args.tile),
                               name))
        panels.append(labelled(fit_tile(heatmap(mask), args.tile),
                               f"{name} heatmap"))
    panels.extend([
        labelled(fit_tile(masked_source(bgr, front), args.tile), "final front"),
        labelled(fit_tile(masked_source(bgr, back), args.tile), "final back"),
    ])
    columns = 5
    blank = np.full_like(panels[0], 31)
    while len(panels) % columns:
        panels.append(blank)
    rows = [np.concatenate(panels[i:i + columns], axis=1)
            for i in range(0, len(panels), columns)]
    sheet = np.concatenate(rows, axis=0)
    cv2.imwrite(str(output / "stages.jpg"), sheet,
                [cv2.IMWRITE_JPEG_QUALITY, 97])
    print(output / "stages.jpg")


if __name__ == "__main__":
    main()
