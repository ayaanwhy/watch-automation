"""Build durable cache labels for manually reviewed ownership defects.

The configurator benchmark has no merchant-supplied front/back truth.  This
tool records the small number of reviewed semantic corrections without
changing the full matte.  It writes both native-resolution regression masks
and ordinary ``CachedPairs`` entries suitable for guarded fine-tuning.

    python -m benchmark.build_ownership_corrections
"""

import argparse
import json
import os
import re
import shutil
from pathlib import Path

import cv2
import numpy as np

from vto.ingest import _write


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", default="benchmark/corrections/ownership-v1.json")
    parser.add_argument("--out", default="data/corrections/ownership-v1")
    parser.add_argument("--assets", default="benchmark/corrections/ownership-v1-assets")
    parser.add_argument("--size", type=int, default=512)
    return parser.parse_args()


def _resolve_cases(spec, report):
    available = {case["id"]: case for case in report["cases"]}
    resolved = []
    for rule in spec["rules"]:
        ids = list(rule.get("case_ids", []))
        if rule.get("case_id_regex"):
            pattern = re.compile(rule["case_id_regex"])
            ids.extend(case_id for case_id in available if pattern.match(case_id))
        for case_id in sorted(set(ids)):
            if case_id not in available:
                raise ValueError(f"correction case is absent from report: {case_id}")
            resolved.append((case_id, rule, available[case_id]))
    return resolved


def _mirror_secondary_component(full, old_back):
    support = (old_back > 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(support, 8)
    order = sorted(range(1, count),
                   key=lambda index: stats[index, cv2.CC_STAT_AREA], reverse=True)
    if len(order) < 2:
        raise ValueError("expected a detached secondary back component")
    secondary = labels == order[1]
    ys, xs = np.nonzero(full > 0.5)
    axis = (float(xs.min()) + float(xs.max())) / 2.0
    mirrored = np.zeros_like(secondary)
    yy, xx = np.nonzero(secondary)
    mirror_x = np.rint(2.0 * axis - xx).astype(np.int32)
    valid = (mirror_x >= 0) & (mirror_x < secondary.shape[1])
    mirrored[yy[valid], mirror_x[valid]] = True
    return mirrored & (full > 0.5)


def _polygon_mask(shape, normalized):
    height, width = shape
    points = np.asarray([
        [round(x * width), round(y * height)] for x, y in normalized
    ], dtype=np.int32)
    mask = np.zeros(shape, np.uint8)
    cv2.fillPoly(mask, [points], 1)
    return mask > 0


def _correct(full, old_back, operation):
    solid = full > 0.5
    corrected = old_back > 0.5
    kind = operation["type"]
    if kind == "mirror_secondary_back_component":
        requested = _mirror_secondary_component(full, old_back)
    elif kind == "add_symmetric_polygons":
        left = _polygon_mask(full.shape, operation["left_polygon_normalized"])
        right = left[:, ::-1]
        requested = (left | right) & solid
    else:
        raise ValueError(f"unknown correction operation: {kind}")
    added = requested & ~corrected
    corrected |= requested
    corrected &= solid
    return corrected, added


def _design_id(rule, case_id):
    if rule.get("design_id"):
        return rule["design_id"]
    match = re.match(r"^side-(bead|channel)-", case_id)
    setting = match.group(1) if match else "unknown"
    return rule["design_id_template"].format(setting=setting, case_id=case_id)


def main():
    args = parse_args()
    spec_path = Path(args.spec)
    spec = json.loads(spec_path.read_text())
    report_path = Path(spec["report"])
    snapshot_path = Path(spec["snapshot"])
    report = json.loads(report_path.read_text())
    result_path = report_path.parent
    output_path = Path(args.out)
    assets_path = Path(args.assets)
    output_path.mkdir(parents=True, exist_ok=True)
    assets_path.mkdir(parents=True, exist_ok=True)

    manifest = {"version": spec["version"], "spec": str(spec_path), "cases": []}
    for case_id, rule, case in _resolve_cases(spec, report):
        if case.get("status") != "ok":
            raise ValueError(f"cannot correct unavailable case: {case_id}")
        source = cv2.imread(str(snapshot_path / case["source_file"]))
        full_u8 = cv2.imread(str(result_path / case["masks"]["full"]),
                             cv2.IMREAD_GRAYSCALE)
        old_back_u8 = cv2.imread(str(result_path / case["masks"]["back"]),
                                 cv2.IMREAD_GRAYSCALE)
        if source is None or full_u8 is None or old_back_u8 is None:
            raise ValueError(f"missing source or masks for {case_id}")
        full = full_u8.astype(np.float32) / 255.0
        old_back = old_back_u8.astype(np.float32) / 255.0
        corrected, added = _correct(full, old_back, rule["operation"])
        design_id = _design_id(rule, case_id)

        native_dir = assets_path / case_id
        native_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(snapshot_path / case["source_file"], native_dir / "source.jpg")
        cv2.imwrite(str(native_dir / "full.png"), full_u8)
        cv2.imwrite(str(native_dir / "back.png"), corrected.astype(np.uint8) * 255)
        cv2.imwrite(str(native_dir / "added.png"), added.astype(np.uint8) * 255)

        _write(str(output_path), case_id, source, full,
               corrected.astype(np.float32), args.size, 0.10,
               has_back=True, real=True, design_id=design_id,
               family="correction",
               source=f"benchmark_manual_correction_{spec['version']}")
        meta_path = output_path / case_id / "meta.json"
        meta = json.loads(meta_path.read_text())
        meta.update({"benchmark_case": case_id, "correction_version": spec["version"],
                     "correction_note": rule["note"]})
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")

        manifest["cases"].append({
            "id": case_id,
            "design_id": design_id,
            "source_sha256": case["source_sha256"],
            "added_back_pixels": int(added.sum()),
            "back_pixels": int(corrected.sum()),
            "note": rule["note"],
        })
        print(f"[+] {case_id}: {int(added.sum())} pixels added to back")

    (assets_path / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[✓] {len(manifest['cases'])} correction cases -> {output_path}")
    print(f"[✓] native regression assets -> {assets_path}")


if __name__ == "__main__":
    main()
