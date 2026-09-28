"""Run and compare immutable live-configurator segmentation snapshots.

No web server is started. The production ONNX model and the same ``segment``
function used by the API are invoked directly in-process.
"""

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import cv2
import numpy as np


RUNTIME_FILES = ("deploy/serve.py", "vto/post.py",
                 "vto/configurator_benchmark.py")
MIN_BACK_COMPONENT = 300


def valid_occluded_back_halves(mask):
    """Recognize two substantial lower-band pieces split by a front head.

    Multiple tiny/high rear objects are failures.  Two wide pieces with the
    same lower edge and strong vertical overlap are the one valid exception:
    a centre setting genuinely occludes the continuous band in the serialized
    front/back partition.
    """
    solid = np.asarray(mask, bool).astype(np.uint8)
    count, _, stats, centroids = cv2.connectedComponentsWithStats(solid, 8)
    if count != 3:
        return False
    indices = sorted(range(1, count),
                     key=lambda index: int(stats[index, cv2.CC_STAT_AREA]),
                     reverse=True)
    first, second = (stats[index] for index in indices)
    if int(second[cv2.CC_STAT_AREA]) < 0.35 * int(first[cv2.CC_STAT_AREA]):
        return False

    def bounds(component):
        left = int(component[cv2.CC_STAT_LEFT])
        top = int(component[cv2.CC_STAT_TOP])
        width = int(component[cv2.CC_STAT_WIDTH])
        height = int(component[cv2.CC_STAT_HEIGHT])
        return left, left + width - 1, top, top + height - 1, width, height

    a_left, a_right, a_top, a_bottom, a_width, a_height = bounds(first)
    b_left, b_right, b_top, b_bottom, b_width, b_height = bounds(second)
    separated = a_right < b_left or b_right < a_left
    vertical_overlap = max(0, min(a_bottom, b_bottom) -
                           max(a_top, b_top) + 1)
    minimum_height = min(a_height, b_height)
    bottom_tolerance = max(3, int(round(min(solid.shape) * 8.0 / 499.0)))
    centre_delta = abs(float(centroids[indices[0], 1]) -
                       float(centroids[indices[1], 1]))
    aligned_midline = centre_delta <= max(3.0, 0.25 * minimum_height)
    # Match the production cleanup's perspective tolerance.  A genuine rear
    # half can be 56x38 (aspect 1.47) when a large head occludes the band.
    band_like = a_width >= 1.4 * a_height and b_width >= 1.4 * b_height
    return bool(separated and band_like and
                (abs(a_bottom - b_bottom) <= bottom_tolerance or
                 aligned_midline) and
                vertical_overlap >= 0.5 * minimum_height)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def runtime_metadata(model_path):
    model_metadata = model_path.with_name("model.json")
    if not model_metadata.is_file():
        model_metadata = Path("deploy/model.json")
    paths = [*map(Path, RUNTIME_FILES), model_metadata]
    # Match deploy.serve's effective default.  Earlier reports omitted the
    # refiner hash whenever callers relied on that default, so two different
    # deployed refiners could receive the same benchmark runtime signature.
    ownership_refiner = os.environ.get(
        "RING_OWNERSHIP_REFINER", "deploy/ownership_refiner.onnx")
    if ownership_refiner:
        refiner_path = Path(ownership_refiner).resolve()
        if not refiner_path.is_file():
            raise FileNotFoundError(
                f"RING_OWNERSHIP_REFINER does not exist: {refiner_path}")
        paths.append(refiner_path)
        refiner_metadata = refiner_path.with_suffix(".json")
        if refiner_metadata.is_file():
            paths.append(refiner_metadata)
    files = {str(path): sha256_file(path) for path in paths}
    model_sha256 = sha256_file(model_path)
    settings = {
        key: value for key, value in sorted(os.environ.items())
        if (key.startswith("RING_") or key.startswith("GEM_"))
        and key != "RING_MODEL"
    }
    payload = json.dumps({"files": files, "model_sha256": model_sha256,
                          "settings": settings}, sort_keys=True)
    return {
        "signature": hashlib.sha256(payload.encode()).hexdigest(),
        "files": files,
        "model_path": str(model_path),
        "model_sha256": model_sha256,
        "settings": settings,
    }


def mask_metrics(full, front, back, expect_back=True):
    """Return model-independent integrity metrics and review flags."""
    a = np.clip(np.asarray(full, np.float32), 0, 1)
    f = np.clip(np.asarray(front, np.float32), 0, 1)
    b = np.clip(np.asarray(back, np.float32), 0, 1)
    solid = a > 0.5
    front_solid = f > 0.5
    back_solid = b > 0.5
    full_px = int(solid.sum())
    back_px = int(back_solid.sum())
    h, w = solid.shape

    # What users can see is the nonzero support of the serialized 8-bit PNG,
    # not only the >50% binary silhouette.  Measuring both catches faint dust
    # and slivers that the earlier benchmark incorrectly reported as clean.
    support = np.rint(a * 255.0) > 0
    alpha_count, _, alpha_stats, _ = cv2.connectedComponentsWithStats(
        support.astype(np.uint8), 8)
    alpha_areas = (alpha_stats[1:, cv2.CC_STAT_AREA]
                   if alpha_count > 1 else np.array([]))
    tiny_alpha_components = int((alpha_areas < 32).sum())

    labels_count, _, stats, _ = cv2.connectedComponentsWithStats(
        solid.astype(np.uint8), 8)
    areas = stats[1:, cv2.CC_STAT_AREA] if labels_count > 1 else np.array([])
    back_solid_count, _, _, _ = cv2.connectedComponentsWithStats(
        back_solid.astype(np.uint8), 8)
    occluded_back_halves = valid_occluded_back_halves(back_solid)
    back_support = np.rint(b * 255.0) > 0
    back_labels_count, _, back_stats, _ = cv2.connectedComponentsWithStats(
        back_support.astype(np.uint8), 8)
    back_areas = (back_stats[1:, cv2.CC_STAT_AREA]
                  if back_labels_count > 1 else np.array([]))
    tiny_back_components = int((back_areas < MIN_BACK_COMPONENT).sum())
    largest_fraction = float(areas.max() / max(areas.sum(), 1)) if len(areas) else 0.0
    ys, xs = np.nonzero(solid)
    margins = ({"top": int(ys.min()), "right": int(w - 1 - xs.max()),
                "bottom": int(h - 1 - ys.max()), "left": int(xs.min())}
               if len(xs) else {"top": 0, "right": 0, "bottom": 0, "left": 0})
    partition_error = float(np.max(np.abs(a - (f + b))))
    overlap_px = int((front_solid & back_solid).sum())
    border_px = int(solid[0].sum() + solid[-1].sum() +
                    solid[:, 0].sum() + solid[:, -1].sum())
    back_fraction = back_px / max(full_px, 1)
    flags = []
    if full_px == 0:
        flags.append("empty_full_mask")
    if partition_error > 1e-6 or overlap_px:
        flags.append("invalid_layer_partition")
    if border_px:
        flags.append("mask_touches_canvas")
    if full_px and largest_fraction < 0.98:
        flags.append("fragmented_full_mask")
    if tiny_alpha_components:
        flags.append("tiny_alpha_components")
    if expect_back:
        if full_px and not 0.02 <= back_fraction <= 0.40:
            flags.append("back_fraction_outlier")
        if back_solid_count - 1 > 1 and not occluded_back_halves:
            flags.append("multiple_back_components")
        if tiny_back_components:
            flags.append("tiny_back_components")
    elif np.rint(b * 255.0).astype(np.uint8).any():
        flags.append("unexpected_back_pixels")
    return {
        "full_px": full_px,
        "front_px": int(front_solid.sum()),
        "back_px": back_px,
        "back_fraction": round(back_fraction, 6),
        "partition_max_error": partition_error,
        "front_back_overlap_px": overlap_px,
        "full_components": max(labels_count - 1, 0),
        "alpha_components": max(alpha_count - 1, 0),
        "tiny_alpha_components": tiny_alpha_components,
        "back_components": max(back_labels_count - 1, 0),
        "back_solid_components": max(back_solid_count - 1, 0),
        "valid_occluded_back_halves": occluded_back_halves,
        "tiny_back_components": tiny_back_components,
        "largest_component_fraction": round(largest_fraction, 6),
        "border_px": border_px,
        "bbox_margins": margins,
        "partial_alpha_px": int(((a > 0) & (a < 1)).sum()),
        "expects_back": bool(expect_back),
        "flags": flags,
    }


def encode_mask(mask):
    return np.rint(np.clip(mask, 0, 1) * 255).astype(np.uint8)


def fit_tile(image, size=280):
    canvas = np.full((size, size, 3), 31, np.uint8)
    h, w = image.shape[:2]
    scale = min((size - 28) / max(h, 1), size / max(w, 1))
    resized = cv2.resize(image, (max(1, round(w * scale)), max(1, round(h * scale))),
                         interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    y = 28 + max(0, (size - 28 - resized.shape[0]) // 2)
    x = max(0, (size - resized.shape[1]) // 2)
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return canvas


def dark_composite(foreground, alpha):
    weight = np.clip(alpha, 0, 1)[..., None]
    return np.clip(foreground * weight + 31 * (1 - weight), 0, 255).astype(np.uint8)


def labelled(tile, text):
    tile = tile.copy()
    cv2.rectangle(tile, (0, 0), (tile.shape[1], 27), (31, 31, 31), -1)
    cv2.putText(tile, text[:42], (7, 19), cv2.FONT_HERSHEY_SIMPLEX,
                0.45, (245, 245, 245), 1, cv2.LINE_AA)
    return tile


def write_review_pages(rows, output_dir, page_size=20):
    paths = []
    for index in range(0, len(rows), page_size):
        chunk = rows[index:index + page_size]
        page = np.concatenate(chunk, axis=0)
        relative = f"review_{index // page_size + 1:03d}.jpg"
        cv2.imwrite(str(output_dir / relative), page,
                    [cv2.IMWRITE_JPEG_QUALITY, 92])
        paths.append(relative)
    return paths


def run_snapshot(args):
    snapshot_dir = Path(args.snapshot).resolve()
    manifest_path = snapshot_dir / "manifest.json"
    with open(manifest_path) as handle:
        manifest = json.load(handle)
    available_cases = {case["id"]: case for case in manifest["cases"]}
    if args.review_order:
        with open(args.review_order) as handle:
            review = json.load(handle)
        ordered_ids = [case["id"] for case in review["cases"]]
        unknown = [case_id for case_id in ordered_ids
                   if case_id not in available_cases]
        if unknown:
            raise ValueError(f"review order contains unknown cases: {unknown[:5]}")
        selected_cases = [available_cases[case_id] for case_id in ordered_ids]
    else:
        selected_cases = list(manifest["cases"])
    if args.limit:
        selected_cases = selected_cases[:args.limit]
    scope = {
        "review_order": (str(Path(args.review_order).resolve())
                         if args.review_order else None),
        "limit": args.limit,
        "case_ids": [case["id"] for case in selected_cases],
    }
    model = Path(args.model).resolve()
    os.environ["RING_MODEL"] = str(model)
    runtime = runtime_metadata(model)
    result_name = runtime["signature"][:16]
    if args.review_order or args.limit:
        scope_digest = hashlib.sha256(
            json.dumps(scope, sort_keys=True).encode()).hexdigest()[:8]
        result_name = f"{result_name}-subset-{scope_digest}"
    output_dir = (Path(args.out_root).resolve() / manifest["snapshot_id"] /
                  result_name)
    if output_dir.exists():
        raise FileExistsError(f"immutable result already exists: {output_dir}")
    (output_dir / "masks").mkdir(parents=True)

    # Import only after RING_MODEL has been set. Importing initializes the ONNX
    # session but does not launch uvicorn or bind a network port.
    import deploy.serve as serving
    segment, segment_gem = serving.segment, serving.segment_gem
    runtime["execution"] = {
        "onnxruntime_version": serving.ort.__version__,
        "available_providers": serving.ort.get_available_providers(),
        "active_providers": serving._sess.get_providers(),
        "required_provider": serving.PROVIDER_OVERRIDE,
        "cpu_fallback_disabled": bool(
            serving.PROVIDER_OVERRIDE and
            serving.PROVIDER_OVERRIDE != "CPUExecutionProvider"),
    }

    results = []
    rows = []
    run_started = time.perf_counter()
    default_asset_type = manifest.get("asset_type", "ring")
    for case in selected_cases:
        asset_type = case.get("asset_type", default_asset_type)
        is_gemstone = asset_type in ("gem", "gemstone")
        if case.get("status") != "ok":
            status = ("source_unavailable" if case.get("status") == "not_available"
                      else "source_error")
            results.append({"id": case.get("id"), "status": status,
                            "asset_type": asset_type,
                            "source_status": case.get("status")})
            continue
        source_path = snapshot_dir / case["image"]["file"]
        source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
        if source is None:
            results.append({"id": case["id"], "status": "source_decode_error"})
            continue
        segment_fn = segment_gem if is_gemstone else segment
        case_started = time.perf_counter()
        full, front, back, foreground = segment_fn(source)
        segment_ms = round(1000 * (time.perf_counter() - case_started), 1)
        metrics = mask_metrics(full, front, back, expect_back=not is_gemstone)
        mask_files = {}
        for label, mask in (("full", full), ("front", front), ("back", back)):
            relative = f"masks/{case['id']}_{label}.png"
            cv2.imwrite(str(output_dir / relative), encode_mask(mask))
            mask_files[label] = relative
        results.append({
            "id": case["id"], "status": "review" if metrics["flags"] else "ok",
            "asset_type": asset_type,
            "source_sha256": case["image"]["sha256"],
            "source_file": case["image"]["file"],
            "selected": case.get("selected", {}),
            "metrics": metrics, "masks": mask_files,
            "segment_ms": segment_ms,
        })
        panels = [
            labelled(fit_tile(source), f"{case['id']} source"),
            labelled(fit_tile(dark_composite(foreground, front)), "front / dark"),
            labelled(fit_tile(dark_composite(foreground, back)), "back / dark"),
            labelled(fit_tile(dark_composite(foreground, full)), "full / dark"),
        ]
        rows.append(np.concatenate(panels, axis=1))
        print(f"{case['id']}: {results[-1]['status']} "
              f"full={metrics['full_px']} back={metrics['back_px']} "
              f"flags={','.join(metrics['flags']) or '-'}")

    reviews = write_review_pages(rows, output_dir) if rows else []
    summary = {
        "cases": len(results),
        "ok": sum(item["status"] == "ok" for item in results),
        "review": sum(item["status"] == "review" for item in results),
        "unavailable": sum(item["status"] == "source_unavailable" for item in results),
        "errors": sum(item["status"] not in
                      ("ok", "review", "source_unavailable") for item in results),
    }
    processed_times = [item["segment_ms"] for item in results
                       if "segment_ms" in item]
    summary["elapsed_seconds"] = round(time.perf_counter() - run_started, 3)
    summary["mean_segment_ms"] = round(float(np.mean(processed_times)), 1)
    summary["median_segment_ms"] = round(float(np.median(processed_times)), 1)
    report = {
        "schema_version": 1,
        "snapshot_id": manifest["snapshot_id"],
        "scope": scope,
        "asset_type": manifest.get("asset_type", "ring"),
        "snapshot_manifest_sha256": sha256_file(manifest_path),
        "runtime": runtime,
        "summary": summary,
        "review_pages": reviews,
        "cases": results,
    }
    with open(output_dir / "report.json", "w") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    print(f"report: {output_dir / 'report.json'}")
    return 2 if summary["review"] or summary["errors"] else 0


def binary_iou(left, right):
    left, right = left > 127, right > 127
    return float((left & right).sum() / max((left | right).sum(), 1))


def compare_runs(args):
    with open(args.baseline) as handle:
        baseline = json.load(handle)
    with open(args.candidate) as handle:
        candidate = json.load(handle)
    if baseline["snapshot_id"] != candidate["snapshot_id"]:
        raise ValueError("reports refer to different source snapshots")
    left_root, right_root = Path(args.baseline).parent, Path(args.candidate).parent
    left = {case["id"]: case for case in baseline["cases"] if "masks" in case}
    right = {case["id"]: case for case in candidate["cases"] if "masks" in case}
    comparisons = []
    for case_id in sorted(set(left) | set(right)):
        if case_id not in left or case_id not in right:
            comparisons.append({"id": case_id, "status": "missing_case"})
            continue
        if left[case_id].get("source_sha256") != right[case_id].get("source_sha256"):
            comparisons.append({"id": case_id, "status": "source_mismatch"})
            continue
        layers = {}
        for layer in ("full", "front", "back"):
            a = cv2.imread(str(left_root / left[case_id]["masks"][layer]),
                           cv2.IMREAD_GRAYSCALE)
            b = cv2.imread(str(right_root / right[case_id]["masks"][layer]),
                           cv2.IMREAD_GRAYSCALE)
            layers[layer] = {
                "binary_iou": round(binary_iou(a, b), 8),
                "changed_px": int(((a > 127) != (b > 127)).sum()),
                "mean_alpha_delta": round(float(np.abs(a.astype(float) - b).mean()), 6),
            }
        comparisons.append({"id": case_id, "status": "ok", "layers": layers})
    output = {
        "schema_version": 1, "snapshot_id": baseline["snapshot_id"],
        "baseline_runtime": baseline["runtime"]["signature"],
        "candidate_runtime": candidate["runtime"]["signature"],
        "cases": comparisons,
    }
    if args.out:
        with open(args.out, "w") as handle:
            json.dump(output, handle, indent=2)
            handle.write("\n")
    print(json.dumps(output, indent=2))
    return 0


def parse_args():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--snapshot", required=True)
    run.add_argument("--model", default="deploy/model.onnx")
    run.add_argument("--out-root", default="benchmark/results")
    run.add_argument("--review-order",
                     help="manual_review.json whose case order should be used")
    run.add_argument("--limit", type=int,
                     help="run only the first N cases after ordering")
    compare = sub.add_parser("compare")
    compare.add_argument("--baseline", required=True)
    compare.add_argument("--candidate", required=True)
    compare.add_argument("--out")
    return parser.parse_args()


def main():
    args = parse_args()
    return run_snapshot(args) if args.command == "run" else compare_runs(args)


if __name__ == "__main__":
    raise SystemExit(main())
