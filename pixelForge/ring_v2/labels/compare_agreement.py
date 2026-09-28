"""Compare two independently audited editor lanes at native resolution."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import shutil
import tempfile
import time
from typing import Any

import cv2
import numpy as np

from .audit import sha256_file
from .metrics import (aggregate, binary_boundary, binary_iou, boundary_f1,
                      cldice, component_areas, connectivity_error, dilate,
                      gradient_error, hole_areas, thin_structure_recall)


def _load_report(path: Path) -> dict[str, Any]:
    report = json.loads(path.read_text())
    if not report.get("summary", {}).get("complete"):
        raise ValueError(f"agreement comparison requires a complete audit: {path}")
    if report["summary"].get("quarantined") or report["summary"].get("missing"):
        raise ValueError(f"agreement comparison cannot use failed labels: {path}")
    return report


def _ownership_seam(ownership: np.ndarray) -> np.ndarray:
    front = ownership == 1
    back = ownership == 2
    # Keep only front/back adjacency.  Outer silhouette boundaries are matte edges,
    # not ownership seams.
    return (back & dilate(front, 1)) | (front & dilate(back, 1))


def _macro_f1(first: np.ndarray, second: np.ndarray,
              valid: np.ndarray) -> float:
    scores = []
    for label in (1, 2):
        first_label = valid & (first == label)
        second_label = valid & (second == label)
        true_positive = int((first_label & second_label).sum())
        denominator = int(first_label.sum()) + int(second_label.sum())
        scores.append(1.0 if denominator == 0 else 2.0 * true_positive / denominator)
    return float(np.mean(scores))


def compare_targets(first: dict[str, np.ndarray],
                    second: dict[str, np.ndarray]) -> dict[str, float | int]:
    """Return symmetric agreement metrics for a pair of audited targets."""
    first_full = first["full_alpha"].astype(np.float32)
    second_full = second["full_alpha"].astype(np.float32)
    if first_full.shape != second_full.shape:
        raise ValueError("audited target dimensions differ")
    first_solid = first_full >= 0.5
    second_solid = second_full >= 0.5
    boundary_region = dilate(
        binary_boundary(first_solid) | binary_boundary(second_solid), 4)
    alpha_delta = np.abs(first_full - second_full)

    first_ownership = first["ownership"]
    second_ownership = second["ownership"]
    joint_confident = np.isin(first_ownership, (1, 2)) & np.isin(
        second_ownership, (1, 2))
    first_back = first_ownership == 2
    second_back = second_ownership == 2
    first_seam = _ownership_seam(first_ownership)
    second_seam = _ownership_seam(second_ownership)
    first_thin_recall = thin_structure_recall(first_solid, second_solid)
    second_thin_recall = thin_structure_recall(second_solid, first_solid)

    return {
        "full_iou": binary_iou(first_solid, second_solid),
        "full_boundary_f1_1px": boundary_f1(first_solid, second_solid, 1),
        "full_boundary_f1_2px": boundary_f1(first_solid, second_solid, 2),
        "boundary_band_alpha_mad": (
            float(alpha_delta[boundary_region].mean()) if np.any(boundary_region) else 0.0),
        "boundary_band_alpha_mse": (
            float(np.square(alpha_delta[boundary_region]).mean())
            if np.any(boundary_region) else 0.0),
        "gradient_error": gradient_error(first_full, second_full, boundary_region),
        "connectivity_error": connectivity_error(first_full, second_full),
        "cldice": cldice(first_solid, second_solid),
        "thin_recall_a_to_b": first_thin_recall,
        "thin_recall_b_to_a": second_thin_recall,
        "thin_recall_symmetric": (first_thin_recall + second_thin_recall) / 2.0,
        "full_components_a": len(component_areas(first_solid)),
        "full_components_b": len(component_areas(second_solid)),
        "full_component_count_difference": abs(
            len(component_areas(first_solid)) - len(component_areas(second_solid))),
        "full_holes_a": len(hole_areas(first_solid)),
        "full_holes_b": len(hole_areas(second_solid)),
        "full_hole_count_difference": abs(
            len(hole_areas(first_solid)) - len(hole_areas(second_solid))),
        "joint_confident_ownership_pixels": int(joint_confident.sum()),
        "ownership_agreement": (
            float((first_ownership[joint_confident] ==
                   second_ownership[joint_confident]).mean())
            if np.any(joint_confident) else 1.0),
        "ownership_macro_f1": _macro_f1(
            first_ownership, second_ownership, joint_confident),
        "back_iou": binary_iou(first_back, second_back),
        "ownership_seam_boundary_f1_2px": boundary_f1(
            first_seam, second_seam, 2),
        "back_fraction_a": float(first_back.sum() / max(1, int(first_solid.sum()))),
        "back_fraction_b": float(second_back.sum() / max(1, int(second_solid.sum()))),
        "back_fraction_absolute_error": abs(
            float(first_back.sum() / max(1, int(first_solid.sum()))) -
            float(second_back.sum() / max(1, int(second_solid.sum())))),
        "back_components_a": len(component_areas(first_back)),
        "back_components_b": len(component_areas(second_back)),
        "back_component_count_difference": abs(
            len(component_areas(first_back)) - len(component_areas(second_back))),
    }


def _rgba_on_dark(source: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    background = np.full_like(source, 32)
    weight = alpha[..., None].astype(np.float32)
    return np.clip(source * weight + background * (1.0 - weight), 0, 255).astype(np.uint8)


def _preview(source: np.ndarray, first: dict[str, np.ndarray],
             second: dict[str, np.ndarray], destination: Path) -> None:
    height, width = source.shape[:2]
    maximum = 400
    scale = min(1.0, maximum / max(height, width))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))

    def resize_image(image: np.ndarray) -> np.ndarray:
        return cv2.resize(image, size, interpolation=cv2.INTER_AREA)

    top = [resize_image(source)]
    for target in (first, second):
        top.append(resize_image(_rgba_on_dark(source, target["full_alpha"])))
    full_delta = np.abs(first["full_alpha"] - second["full_alpha"])
    delta_panel = np.full_like(source, 32)
    delta_panel[:, :, 2] = np.maximum(
        delta_panel[:, :, 2], np.clip(full_delta * 255 * 4, 0, 255).astype(np.uint8))
    top.append(resize_image(delta_panel))

    bottom = []
    for target in (first, second):
        panel = np.full_like(source, 32)
        panel[target["ownership"] == 1] = (60, 190, 60)
        panel[target["ownership"] == 2] = (220, 150, 40)
        panel[target["ignore"]] = (180, 60, 210)
        bottom.append(resize_image(panel))
    mismatch = np.full_like(source, 32)
    valid = np.isin(first["ownership"], (1, 2)) & np.isin(
        second["ownership"], (1, 2))
    mismatch[valid & (first["ownership"] != second["ownership"])] = (0, 0, 255)
    bottom.append(resize_image(mismatch))
    bottom.append(np.full_like(bottom[0], 32))
    image = np.concatenate((np.concatenate(top, axis=1),
                            np.concatenate(bottom, axis=1)), axis=0)
    if not cv2.imwrite(str(destination), image, [cv2.IMWRITE_JPEG_QUALITY, 94]):
        raise OSError(f"failed to write {destination}")


def _html_report(records: list[dict[str, Any]], destination: Path) -> None:
    cards = []
    for record in records:
        metric = record["metrics"]
        cards.append(
            "<article><h2>" + html.escape(record["case_id"]) + "</h2>"
            f"<img src=\"{html.escape(record['preview_file'])}\" loading=\"lazy\">"
            "<p>Full BF@2: " + f"{metric['full_boundary_f1_2px']:.4f}"
            " · ownership: " + f"{metric['ownership_agreement']:.4f}"
            " · seam BF@2: " + f"{metric['ownership_seam_boundary_f1_2px']:.4f}"
            " · components A/B: " +
            f"{metric['full_components_a']}/{metric['full_components_b']}</p></article>")
    destination.write_text("""<!doctype html><html><head><meta charset="utf-8">
<title>Ring v2 independent editor agreement</title><style>
body{background:#17191c;color:#eee;font:14px system-ui;margin:24px}article{margin:0 0 32px}
h1,h2{font-weight:600}img{display:block;max-width:100%;border:1px solid #444;background:#222}
p{color:#ddd}.legend{padding:12px;background:#24272b;position:sticky;top:0}
</style></head><body><h1>Independent editor agreement</h1>
<p class="legend">Panels: source · editor A full · editor B full · full disagreement;
editor A ownership · editor B ownership · ownership disagreement. Green=front,
gold=back, purple=ignored, red=disagreement. No model predictions are included.</p>
""" + "\n".join(cards) + "</body></html>\n")


def compare(first_audit: Path, second_audit: Path, output: Path) -> dict[str, Any]:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite agreement comparison: {output}")
    first_report_path = first_audit / "report.json"
    second_report_path = second_audit / "report.json"
    first_report = _load_report(first_report_path)
    second_report = _load_report(second_report_path)
    if first_report["agreement_manifest_sha256"] != second_report["agreement_manifest_sha256"]:
        raise ValueError("editor audits were not produced from the same agreement manifest")
    first_cases = {case["case_id"]: case for case in first_report["cases"]}
    second_cases = {case["case_id"]: case for case in second_report["cases"]}
    if set(first_cases) != set(second_cases):
        raise ValueError("editor audits contain different case IDs")
    agreement_manifest = Path(first_report["agreement_manifest"])
    workspace = agreement_manifest.parent
    source_records = {
        case["case_id"]: case
        for case in json.loads(agreement_manifest.read_text())["cases"]
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        preview_dir = staging / "previews"
        preview_dir.mkdir()
        records = []
        for case_id in sorted(first_cases):
            with np.load(first_audit / first_cases[case_id]["target_file"]) as data:
                first = {key: data[key].copy() for key in data.files}
            with np.load(second_audit / second_cases[case_id]["target_file"]) as data:
                second = {key: data[key].copy() for key in data.files}
            source = cv2.imread(
                str(workspace / source_records[case_id]["source_file"]),
                cv2.IMREAD_COLOR)
            if source is None:
                raise ValueError(f"cannot decode agreement source: {case_id}")
            preview = preview_dir / f"{case_id}.jpg"
            _preview(source, first, second, preview)
            records.append({
                "case_id": case_id,
                "category": source_records[case_id].get("category"),
                "focus": source_records[case_id].get("focus", []),
                "metrics": compare_targets(first, second),
                "preview_file": f"previews/{case_id}.jpg",
            })

        metric_names = sorted(records[0]["metrics"]) if records else []
        aggregates = {
            name: aggregate(
                float(record["metrics"][name]) for record in records)
            for name in metric_names
        }
        report = {
            "schema_version": 1,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "agreement_manifest": str(agreement_manifest),
            "agreement_manifest_sha256": first_report["agreement_manifest_sha256"],
            "editor_a_audit": str(first_audit),
            "editor_a_report_sha256": sha256_file(first_report_path),
            "editor_b_audit": str(second_audit),
            "editor_b_report_sha256": sha256_file(second_report_path),
            "case_count": len(records),
            "model_predictions_included": False,
            "aggregates": aggregates,
            "cases": records,
            "adjudication": {
                "status": "pending",
                "required": True,
                "instructions": (
                    "Review the lowest matte boundary, ownership and seam agreement "
                    "cases without consulting any model output. Record whether the "
                    "label contract or either editor label must change, then version "
                    "the contract and rerun both audits and this comparison."),
            },
        }
        (staging / "report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n")
        _html_report(sorted(records, key=lambda item: (
            item["metrics"]["full_boundary_f1_2px"] +
            item["metrics"]["ownership_agreement"] +
            item["metrics"]["ownership_seam_boundary_f1_2px"])),
                     staging / "review.html")
        (staging / "ADJUDICATION.md").write_text(
            "# Editor agreement adjudication\n\n"
            "Status: pending\n\n"
            "Review the cases in `review.html` without opening model predictions. For "
            "each material disagreement, record the case ID, disputed pixels/structure, "
            "contract interpretation, final decision and editor initials. After all "
            "disagreements are resolved, version the label contract and regenerate the "
            "audits and report; do not edit this generated metric report in place.\n")
        staging.rename(output)
        return report
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--editor-a-audit", type=Path, required=True)
    parser.add_argument("--editor-b-audit", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = compare(args.editor_a_audit.resolve(), args.editor_b_audit.resolve(),
                     args.out.resolve())
    print(f"[✓] compared {report['case_count']} independent editor labels -> {args.out}")


if __name__ == "__main__":
    main()
