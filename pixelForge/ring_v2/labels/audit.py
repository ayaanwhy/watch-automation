"""Audit native editor labels and derive lossless v2 training targets.

Invalid labels are quarantined with explicit reasons.  This command never resizes,
aligns, fills, trims, or otherwise repairs an editor label.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import tempfile
import time
from typing import Any

import cv2
import numpy as np

from . import LABEL_CONTRACT
from .metrics import (binary_boundary, component_areas, hole_areas,
                      thickness_summary)


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
CONTAINMENT_TOLERANCE = 1.0 / 255.0
OWNERSHIP_CONFIDENCE = 0.90
LOW_ALPHA_OWNERSHIP = 0.10
ALPHA_EPSILON = 1.0 / 65535.0


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def png_header(path: Path) -> dict[str, int]:
    """Read the PNG IHDR without allowing palette conversion to hide defects."""
    header = path.read_bytes()[:29]
    if len(header) < 29 or header[:8] != PNG_SIGNATURE or header[12:16] != b"IHDR":
        raise ValueError("not a valid PNG with an IHDR chunk")
    width, height = struct.unpack(">II", header[16:24])
    return {
        "width": width,
        "height": height,
        "bit_depth": int(header[24]),
        "colour_type": int(header[25]),
        "compression": int(header[26]),
        "filter": int(header[27]),
        "interlace": int(header[28]),
    }


def decode_rgba(path: Path) -> tuple[np.ndarray, np.ndarray, dict[str, int]]:
    header = png_header(path)
    if header["colour_type"] != 6:
        raise ValueError(
            f"PNG must be true-colour RGBA (colour type 6), got {header['colour_type']}")
    if header["bit_depth"] not in (8, 16):
        raise ValueError(f"RGBA bit depth must be 8 or 16, got {header['bit_depth']}")
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] != 4:
        raise ValueError("OpenCV could not decode four-channel RGBA pixels")
    expected_dtype = np.uint8 if header["bit_depth"] == 8 else np.uint16
    if image.dtype != expected_dtype:
        raise ValueError(
            f"decoded dtype {image.dtype} does not match {header['bit_depth']}-bit IHDR")
    maximum = float(np.iinfo(image.dtype).max)
    alpha = image[:, :, 3].astype(np.float32) / maximum
    if not np.all(np.isfinite(alpha)):
        raise ValueError("alpha contains non-finite values")
    return image, alpha, header


def derive_targets(full_alpha: np.ndarray, editor_front_alpha: np.ndarray) -> dict[str, np.ndarray]:
    """Derive an exact matte partition and categorical ownership targets."""
    full = np.asarray(full_alpha, dtype=np.float32)
    front = np.minimum(np.maximum(editor_front_alpha, 0.0), full).astype(np.float32)
    back = (full - front).astype(np.float32)
    foreground = full > ALPHA_EPSILON
    supervised = full >= LOW_ALPHA_OWNERSHIP
    q_front = np.zeros_like(full)
    q_front[foreground] = front[foreground] / np.maximum(
        full[foreground], ALPHA_EPSILON)
    q_back = 1.0 - q_front

    ambiguous = supervised & (q_front < OWNERSHIP_CONFIDENCE) & (
        q_back < OWNERSHIP_CONFIDENCE)
    kernel = np.ones((3, 3), np.uint8)
    ambiguous_dilated = cv2.dilate(ambiguous.astype(np.uint8), kernel) != 0
    ignore = (foreground & ~supervised) | (ambiguous_dilated & foreground)

    ownership = np.full(full.shape, 255, np.uint8)
    ownership[~foreground] = 0
    ownership[supervised & ~ignore & (q_front >= OWNERSHIP_CONFIDENCE)] = 1
    ownership[supervised & ~ignore & (q_back >= OWNERSHIP_CONFIDENCE)] = 2
    return {
        "full_alpha": full,
        "front_alpha": front,
        "back_alpha": back,
        "ownership": ownership,
        "ignore": ignore,
        "ambiguous": ambiguous,
        "q_front": q_front,
    }


def _alpha_stats(alpha: np.ndarray) -> dict[str, Any]:
    support = alpha > ALPHA_EPSILON
    solid = alpha >= 0.5
    boundary = binary_boundary(support)
    boundary_values = alpha[boundary]
    return {
        "minimum": float(alpha.min()),
        "maximum": float(alpha.max()),
        "nonzero_pixels": int(support.sum()),
        "solid_pixels": int(solid.sum()),
        "soft_pixels": int((support & (alpha < 1.0)).sum()),
        "components": len(component_areas(solid)),
        "component_areas": component_areas(solid),
        "holes": len(hole_areas(solid)),
        "hole_areas": hole_areas(solid),
        "boundary_pixels": int(boundary.sum()),
        "boundary_alpha": {
            "minimum": float(boundary_values.min()) if boundary_values.size else None,
            "median": float(np.median(boundary_values)) if boundary_values.size else None,
            "maximum": float(boundary_values.max()) if boundary_values.size else None,
            "unique_values": int(np.unique(boundary_values).size),
        },
        "touches_canvas": bool(
            np.any(support[0]) or np.any(support[-1]) or
            np.any(support[:, 0]) or np.any(support[:, -1])),
        "thickness": thickness_summary(solid),
    }


def _source_alignment_stats(source: np.ndarray, rgba: np.ndarray,
                            alpha: np.ndarray) -> dict[str, float | int | None]:
    """Record non-destructive alignment evidence; semantic QA remains human."""
    solid = alpha >= 0.5
    boundary_band = cv2.dilate(
        binary_boundary(solid).astype(np.uint8), np.ones((3, 3), np.uint8)) != 0
    source_gray = cv2.cvtColor(source[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)
    gradient = cv2.magnitude(
        cv2.Sobel(source_gray, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(source_gray, cv2.CV_32F, 0, 1, ksize=3))
    colour_delta = np.abs(
        source[:, :, :3].astype(np.float32) - rgba[:, :, :3].astype(np.float32))
    return {
        "solid_pixels_compared": int(solid.sum()),
        "source_gradient_on_boundary_mean": (
            float(gradient[boundary_band].mean()) if np.any(boundary_band) else None),
        "source_to_label_rgb_mae_on_solid": (
            float(colour_delta[solid].mean()) if np.any(solid) else None),
    }


def _render_preview(source: np.ndarray, full: np.ndarray | None,
                    front: np.ndarray | None, back: np.ndarray | None,
                    ignore: np.ndarray | None, destination: Path,
                    errors: list[str]) -> None:
    height, width = source.shape[:2]
    maximum = 420
    scale = min(1.0, maximum / max(height, width))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    source_small = cv2.resize(source[:, :, :3], size, interpolation=cv2.INTER_AREA)
    panels = [source_small]
    for alpha, colour in ((full, (245, 245, 245)), (front, (80, 210, 80)),
                          (back, (220, 170, 60))):
        canvas = np.full_like(source_small, 32)
        if alpha is not None and alpha.shape == (height, width):
            alpha_small = cv2.resize(alpha, size, interpolation=cv2.INTER_AREA)[..., None]
            paint = np.full_like(source_small, colour)
            canvas = np.clip(canvas * (1.0 - alpha_small) + paint * alpha_small,
                             0, 255).astype(np.uint8)
        panels.append(canvas)
    ignore_canvas = np.full_like(source_small, 32)
    if ignore is not None and ignore.shape == (height, width):
        mask = cv2.resize(ignore.astype(np.uint8), size,
                          interpolation=cv2.INTER_NEAREST) != 0
        ignore_canvas[mask] = (180, 60, 220)
    panels.append(ignore_canvas)
    preview = np.concatenate(panels, axis=1)
    if errors:
        cv2.putText(preview, f"QUARANTINED: {errors[0][:90]}", (8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.48, (0, 0, 255), 1, cv2.LINE_AA)
    if not cv2.imwrite(str(destination), preview):
        raise OSError(f"failed to write preview: {destination}")


def _audit_case(case: dict[str, Any], workspace: Path, returned: Path,
                accepted: Path, quarantine: Path, previews: Path) -> dict[str, Any]:
    case_id = case["case_id"]
    source_path = workspace / case["source_file"]
    full_path = returned / f"{case_id};frontFullImage.png"
    front_path = returned / f"{case_id};frontImage.png"
    record: dict[str, Any] = {
        "case_id": case_id,
        "status": "accepted",
        "source_file": str(source_path),
        "source_sha256": sha256_file(source_path),
        "full_file": str(full_path),
        "front_file": str(front_path),
        "errors": [],
        "warnings": [],
    }
    missing = [path.name for path in (full_path, front_path) if not path.is_file()]
    if missing:
        record.update(status="missing", missing_files=missing)
        return record

    source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
    if source is None:
        raise ValueError(f"cannot decode canonical source: {source_path}")
    record["source_dimensions"] = [int(source.shape[1]), int(source.shape[0])]
    decoded: dict[str, tuple[np.ndarray, np.ndarray, dict[str, int]]] = {}
    for name, path in (("full", full_path), ("front", front_path)):
        try:
            rgba, alpha, header = decode_rgba(path)
            decoded[name] = (rgba, alpha, header)
            record[f"{name}_sha256"] = sha256_file(path)
            record[f"{name}_png"] = header
            if alpha.shape != source.shape[:2]:
                record["errors"].append(
                    f"{name} dimensions {alpha.shape[1]}x{alpha.shape[0]} do not match "
                    f"source {source.shape[1]}x{source.shape[0]}")
        except Exception as error:  # collect both decode failures in one QA record
            record["errors"].append(f"{name} decode: {error}")

    full: np.ndarray | None = None
    front: np.ndarray | None = None
    back: np.ndarray | None = None
    ignore: np.ndarray | None = None
    if not record["errors"]:
        full_rgba, full, _ = decoded["full"]
        front_rgba, raw_front, _ = decoded["front"]
        if not np.any(full > ALPHA_EPSILON):
            record["errors"].append("full alpha is empty")
        violation = raw_front - full
        violating = violation > CONTAINMENT_TOLERANCE
        record["containment"] = {
            "tolerance": CONTAINMENT_TOLERANCE,
            "violation_pixels": int(violating.sum()),
            "maximum_front_minus_full": float(max(0.0, float(violation.max()))),
        }
        if np.any(violating):
            record["errors"].append(
                f"front alpha exceeds full alpha by more than 1/255 at "
                f"{int(violating.sum())} pixels")
        if not record["errors"]:
            targets = derive_targets(full, raw_front)
            front = targets["front_alpha"]
            back = targets["back_alpha"]
            ignore = targets["ignore"]
            ownership = targets["ownership"]
            reconstruction = np.abs(front + back - full)
            confident_foreground = (full >= LOW_ALPHA_OWNERSHIP) & ~ignore
            unassigned = confident_foreground & ~np.isin(ownership, (1, 2))
            double_assigned = np.zeros_like(unassigned)  # categorical by construction
            record["derivation"] = {
                "alpha_epsilon": ALPHA_EPSILON,
                "low_alpha_ownership_threshold": LOW_ALPHA_OWNERSHIP,
                "ownership_confidence": OWNERSHIP_CONFIDENCE,
                "seam_dilation_pixels": 1,
                "maximum_reconstruction_error": float(reconstruction.max()),
                "unassigned_confident_pixels": int(unassigned.sum()),
                "double_assigned_confident_pixels": int(double_assigned.sum()),
                "ambiguous_pixels_before_dilation": int(targets["ambiguous"].sum()),
                "ignored_pixels": int(ignore.sum()),
                "ignored_fraction_of_full_support": float(
                    ignore.sum() / max(1, int((full > ALPHA_EPSILON).sum()))),
            }
            if float(reconstruction.max()) > CONTAINMENT_TOLERANCE:
                record["errors"].append("derived layers do not reconstruct full alpha")
            if np.any(unassigned) or np.any(double_assigned):
                record["errors"].append("confident foreground ownership is incomplete")
            record["alpha"] = {
                "full": _alpha_stats(full),
                "front": _alpha_stats(front),
                "back": _alpha_stats(back),
            }
            record["source_relation"] = {
                "full": _source_alignment_stats(source, full_rgba, full),
                "front": _source_alignment_stats(source, front_rgba, front),
                "automatic_semantic_certification": False,
            }
            if record["alpha"]["full"]["touches_canvas"]:
                record["warnings"].append(
                    "full alpha touches the canvas; verify the source object genuinely does")

    if record["errors"]:
        record["status"] = "quarantined"
        case_quarantine = quarantine / case_id
        case_quarantine.mkdir()
        shutil.copy2(full_path, case_quarantine / full_path.name)
        shutil.copy2(front_path, case_quarantine / front_path.name)
    else:
        np.savez_compressed(
            accepted / f"{case_id}.npz",
            full_alpha=full.astype(np.float32),
            front_alpha=front.astype(np.float32),
            back_alpha=back.astype(np.float32),
            ownership=ownership,
            ignore=ignore,
        )
        record["target_file"] = f"accepted/{case_id}.npz"
        record["target_sha256"] = sha256_file(accepted / f"{case_id}.npz")
    _render_preview(source, full, front, back, ignore,
                    previews / f"{case_id}.jpg", record["errors"])
    record["preview_file"] = f"previews/{case_id}.jpg"
    return record


def audit(manifest_path: Path, returned: Path, output: Path,
          allow_missing: bool = False) -> dict[str, Any]:
    """Audit one editor lane into a new immutable output directory."""
    if output.exists():
        raise FileExistsError(f"refusing to overwrite label audit: {output}")
    workspace = manifest_path.parent
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("label_contract") != LABEL_CONTRACT:
        raise ValueError(
            f"manifest contract {manifest.get('label_contract')!r} does not match "
            f"auditor contract {LABEL_CONTRACT!r}")
    if not returned.is_dir():
        raise FileNotFoundError(f"returned-label directory does not exist: {returned}")
    for case in manifest["cases"]:
        source_path = workspace / case["source_file"]
        if not source_path.is_file():
            raise FileNotFoundError(f"canonical source is missing: {source_path}")
        actual_source_hash = sha256_file(source_path)
        if actual_source_hash != case["source_sha256"]:
            raise ValueError(
                f"canonical source hash changed for {case['case_id']}: "
                f"expected {case['source_sha256']}, got {actual_source_hash}")
    expected_names = {
        name
        for case in manifest["cases"]
        for name in (f"{case['case_id']};frontFullImage.png",
                     f"{case['case_id']};frontImage.png")
    }
    actual_files = {path.name for path in returned.iterdir() if path.is_file()}
    unexpected = sorted(actual_files - expected_names)

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        accepted = staging / "accepted"
        quarantine = staging / "quarantine"
        previews = staging / "previews"
        for directory in (accepted, quarantine, previews):
            directory.mkdir()
        records = [
            _audit_case(case, workspace, returned, accepted, quarantine, previews)
            for case in manifest["cases"]
        ]
        counts = {
            status: sum(record["status"] == status for record in records)
            for status in ("accepted", "quarantined", "missing")
        }
        qa_passed = counts["quarantined"] == 0 and not unexpected
        complete = qa_passed and counts["missing"] == 0
        report = {
            "schema_version": 1,
            "label_contract": LABEL_CONTRACT,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "agreement_manifest": str(manifest_path),
            "agreement_manifest_sha256": sha256_file(manifest_path),
            "returned_directory": str(returned),
            "model_predictions_included": False,
            "configuration": {
                "containment_tolerance": CONTAINMENT_TOLERANCE,
                "alpha_epsilon": ALPHA_EPSILON,
                "ownership_confidence": OWNERSHIP_CONFIDENCE,
                "low_alpha_ownership_threshold": LOW_ALPHA_OWNERSHIP,
                "seam_dilation_pixels": 1,
                "automatic_resize_or_alignment": False,
                "automatic_repair": False,
            },
            "summary": {
                **counts,
                "expected_cases": len(records),
                "unexpected_file_count": len(unexpected),
                "qa_passed_for_present_labels": qa_passed,
                "complete": complete,
                "allow_missing": allow_missing,
            },
            "unexpected_files": unexpected,
            "limitations": [
                "Structural QA does not certify that the editor retained every ring pixel.",
                "Shadow/background semantics and the ownership convention require human review.",
                "Source-boundary gradient and RGB comparisons are diagnostics, not repair rules.",
            ],
            "cases": records,
        }
        report["exit_ok"] = bool(complete or (allow_missing and qa_passed))
        _write_json(staging / "report.json", report)
        staging.rename(output)
        return report
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--returned", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--allow-missing", action="store_true",
                        help="write a pending audit while editor files are incomplete")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = audit(args.manifest.resolve(), args.returned.resolve(),
                   args.out.resolve(), allow_missing=args.allow_missing)
    summary = report["summary"]
    print(
        f"accepted={summary['accepted']} quarantined={summary['quarantined']} "
        f"missing={summary['missing']} unexpected={summary['unexpected_file_count']}")
    if not report["exit_ok"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
