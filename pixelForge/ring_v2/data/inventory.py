"""Create an immutable provenance and production-exposure inventory.

The inventory is read-only with respect to every dataset it scans.  It records dataset
occurrences rather than assuming that a large folder contains independent truth:
hard-linked recovery copies, generated teacher targets and benchmark derivatives remain
separate records and are joined by hashes in the report.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from typing import Any
import zipfile

import cv2
import numpy as np


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
IMAGE_ROLES = {
    "img.png": "input_rgba_with_full_alpha",
    "back.png": "back_target",
    "base_back.png": "base_back_prediction",
    "full.png": "full_target",
    "front.png": "front_target",
    "source.jpg": "source",
    "source.jpeg": "source",
    "matte_edit.png": "matte_edit_support",
    "back_edit.png": "back_edit_support",
    "action.png": "layer_action_target",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def relative_display(path: Path, repo: Path, trash: Path) -> str:
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        pass
    try:
        return "trash:" + path.resolve().relative_to(trash.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def resolve_location(item: dict[str, Any], repo: Path, trash: Path) -> Path:
    root = repo if item.get("location", "repo") == "repo" else trash
    return root / item["path"]


class ArtifactInspector:
    """Hash and decode files once, including files visible through hard links."""

    def __init__(self, repo: Path, trash: Path):
        self.repo = repo
        self.trash = trash
        self._inode_cache: dict[tuple[int, int, int, int], dict[str, Any]] = {}
        self.file_reads = 0
        self.hardlink_cache_hits = 0

    def inspect(self, path: Path, role: str) -> dict[str, Any]:
        stat = path.stat()
        key = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if key in self._inode_cache:
            details = dict(self._inode_cache[key])
            self.hardlink_cache_hits += 1
        else:
            details = {
                "bytes": int(stat.st_size),
                "sha256": sha256_file(path),
            }
            self.file_reads += 1
            if path.suffix.lower() in IMAGE_SUFFIXES:
                image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
                if image is None:
                    details["decode_error"] = "OpenCV could not decode image"
                else:
                    contiguous = np.ascontiguousarray(image)
                    pixel_digest = hashlib.sha256()
                    pixel_digest.update(str(contiguous.dtype).encode())
                    pixel_digest.update(np.asarray(contiguous.shape, dtype=np.int64).tobytes())
                    pixel_digest.update(contiguous.tobytes())
                    details["image"] = {
                        "width": int(image.shape[1]),
                        "height": int(image.shape[0]),
                        "channels": int(image.shape[2]) if image.ndim == 3 else 1,
                        "dtype": str(image.dtype),
                        "pixel_sha256": pixel_digest.hexdigest(),
                    }
                    if image.ndim == 3 and image.shape[2] == 4:
                        alpha = np.ascontiguousarray(image[:, :, 3])
                        details["image"]["alpha_pixel_sha256"] = hashlib.sha256(
                            alpha.tobytes()).hexdigest()
                        details["image"]["alpha_statistics"] = channel_statistics(alpha)
                    elif image.ndim == 2 and role in {
                            "back_target", "matte_edit_support", "back_edit_support"}:
                        details["image"]["mask_statistics"] = channel_statistics(image)
            self._inode_cache[key] = dict(details)
        return {
            "role": role,
            "path": relative_display(path, self.repo, self.trash),
            **details,
        }


def channel_statistics(channel: np.ndarray) -> dict[str, int | float]:
    """Return compact coverage statistics without retaining decoded pixels."""

    total = int(channel.size)
    maximum = int(np.iinfo(channel.dtype).max) if np.issubdtype(
        channel.dtype, np.integer) else 1
    zero = int(np.count_nonzero(channel == 0))
    opaque = int(np.count_nonzero(channel == maximum))
    nonzero = total - zero
    return {
        "minimum": float(channel.min()),
        "maximum": float(channel.max()),
        "mean": float(channel.mean()),
        "total_pixels": total,
        "nonzero_pixels": nonzero,
        "opaque_pixels": opaque,
        "fractional_pixels": total - zero - opaque,
        "nonzero_fraction": nonzero / total if total else 0.0,
    }


def read_metadata(path: Path) -> tuple[dict[str, Any], str | None]:
    if not path.is_file():
        return {}, None
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}, None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return {}, str(error)


def design_from_name(name: str) -> str:
    if name.startswith("gem_") or name.startswith("gemmulti_"):
        return name
    return name.rsplit("_", 1)[0]


def source_identity(sample: dict[str, Any]) -> tuple[str | None, str | None]:
    metadata_hash = sample.get("metadata", {}).get("source_sha256")
    if metadata_hash:
        return str(metadata_hash), "declared_original_file_sha256"
    priority = ("source", "source_image", "input_rgba_with_full_alpha", "full_target")
    for role in priority:
        for artifact in sample.get("artifacts", []):
            if artifact["role"] != role:
                continue
            if role in ("source", "source_image"):
                return artifact["sha256"], "source_file_sha256"
            image = artifact.get("image", {})
            if image.get("pixel_sha256"):
                return image["pixel_sha256"], f"{role}_pixel_sha256"
            return artifact["sha256"], f"{role}_file_sha256"
    return None, None


def coordinate_check(artifacts: list[dict[str, Any]], roles: tuple[str, ...]) -> dict[str, Any]:
    selected = [artifact for artifact in artifacts if artifact["role"] in roles]
    dimensions = {
        artifact["role"]: [artifact["image"]["width"], artifact["image"]["height"]]
        for artifact in selected if "image" in artifact
    }
    decode_errors = [artifact["path"] for artifact in selected if "decode_error" in artifact]
    same = (len(dimensions) == len(selected) and
            len({tuple(value) for value in dimensions.values()}) <= 1)
    return {
        "roles": list(roles),
        "dimensions": dimensions,
        "same_canvas": bool(same),
        "decode_errors": decode_errors,
    }


def finish_sample(sample: dict[str, Any]) -> dict[str, Any]:
    identity, kind = source_identity(sample)
    sample["source_identity"] = identity
    sample["source_identity_kind"] = kind
    case_key = sample["case_id"]
    for suffix in ("_jpg", "_png"):
        if case_key.endswith(suffix):
            case_key = case_key[:-len(suffix)]
    sample["lineage_case_key"] = case_key
    sample["production_training_exposure"] = "unknown"
    sample["production_selection_exposure"] = "unknown"
    sample["production_exposure"] = "unknown"
    sample["seen_by_production"] = "unknown"
    sample["seen_as_dense_label"] = "unknown"
    sample["seen_as_sparse_correction"] = "unknown"
    sample["seen_by_refiner"] = "unknown"
    sample["benchmark_member"] = False
    sample["frozen_test_eligible"] = False
    sample["frozen_test_exclusion"] = [
        "Inventory does not promote data into the frozen test automatically."
    ]
    return sample


def scan_pair_dirs(spec: dict[str, Any], root: Path,
                   inspector: ArtifactInspector) -> list[dict[str, Any]]:
    samples = []
    for directory in sorted(path for path in root.iterdir() if path.is_dir()):
        artifacts = []
        for filename, role in (("full.png", "full_target"),
                               ("front.png", "front_target")):
            path = directory / filename
            if path.is_file():
                artifacts.append(inspector.inspect(path, role))
        if not artifacts:
            continue
        roles = {artifact["role"] for artifact in artifacts}
        complete = {"full_target", "front_target"}.issubset(roles)
        coordinate = coordinate_check(artifacts, ("full_target", "front_target"))
        samples.append(finish_sample({
            "sample_id": f"{spec['id']}:{directory.name}",
            "case_id": directory.name,
            "dataset_id": spec["id"],
            "design_id": design_from_name(directory.name),
            "asset_type": spec["asset_type"],
            "provenance": spec["provenance"],
            "routing": spec["routing"],
            "complete": complete,
            "coordinate_compatible": bool(complete and coordinate["same_canvas"]),
            "coordinate_check": coordinate,
            "metadata": {},
            "artifacts": artifacts,
        }))
    return samples


def scan_editor_triples(spec: dict[str, Any], root: Path,
                        inspector: ArtifactInspector) -> list[dict[str, Any]]:
    ids = set()
    for path in root.iterdir():
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES:
            ids.add(path.name.split(";", 1)[0].rsplit(".", 1)[0])
    samples = []
    for case_id in sorted(ids):
        expected = ((f"{case_id}.jpg", "source"),
                    (f"{case_id};frontFullImage.png", "full_target"),
                    (f"{case_id};frontImage.png", "front_target"))
        artifacts = [inspector.inspect(root / name, role) for name, role in expected
                     if (root / name).is_file()]
        roles = {artifact["role"] for artifact in artifacts}
        complete = {"source", "full_target", "front_target"}.issubset(roles)
        coordinate = coordinate_check(
            artifacts, ("source", "full_target", "front_target"))
        samples.append(finish_sample({
            "sample_id": f"{spec['id']}:{case_id}",
            "case_id": case_id,
            "dataset_id": spec["id"],
            "design_id": design_from_name(case_id),
            "asset_type": spec["asset_type"],
            "provenance": spec["provenance"],
            "routing": spec["routing"],
            "complete": complete,
            "coordinate_compatible": bool(complete and coordinate["same_canvas"]),
            "coordinate_check": coordinate,
            "metadata": {},
            "artifacts": artifacts,
        }))
    return samples


def artifact_role(path: Path) -> str:
    if path.name in IMAGE_ROLES:
        return IMAGE_ROLES[path.name]
    if path.name.endswith(";frontFullImage.png"):
        return "full_target"
    if path.name.endswith(";frontImage.png"):
        return "front_target"
    return "source_image"


def scan_artifact_dirs(spec: dict[str, Any], root: Path,
                       inspector: ArtifactInspector) -> list[dict[str, Any]]:
    samples = []
    for directory in sorted(path for path in root.iterdir() if path.is_dir()):
        image_paths = sorted(path for path in directory.iterdir()
                             if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES)
        if not image_paths:
            continue
        metadata, metadata_error = read_metadata(directory / "meta.json")
        artifacts = [inspector.inspect(path, artifact_role(path)) for path in image_paths]
        identity_source = next(
            (artifact for artifact in artifacts if artifact["role"] == "source"), None)
        coordinate_roles = tuple(artifact["role"] for artifact in artifacts
                                 if artifact["role"] in
                                 {"source", "full_target", "front_target", "back_target"})
        coordinate = coordinate_check(artifacts, coordinate_roles)
        sample = {
            "sample_id": f"{spec['id']}:{directory.name}",
            "case_id": directory.name,
            "dataset_id": spec["id"],
            "design_id": str(metadata.get("design_id", design_from_name(directory.name))),
            "asset_type": spec["asset_type"],
            "provenance": spec["provenance"],
            "routing": spec["routing"],
            "complete": True,
            "coordinate_compatible": bool(
                coordinate["same_canvas"] if len(coordinate_roles) > 1 else True),
            "coordinate_check": coordinate,
            "metadata": metadata,
            "artifacts": artifacts,
        }
        if metadata_error:
            sample["metadata_error"] = metadata_error
        if identity_source and not metadata.get("source_sha256"):
            sample["metadata"]["source_sha256"] = identity_source["sha256"]
        samples.append(finish_sample(sample))
    return samples


def scan_cache_dirs(spec: dict[str, Any], root: Path,
                    inspector: ArtifactInspector) -> list[dict[str, Any]]:
    samples = scan_artifact_dirs(spec, root, inspector)
    for sample in samples:
        roles = {artifact["role"] for artifact in sample["artifacts"]}
        sample["complete"] = {
            "input_rgba_with_full_alpha", "back_target"
        }.issubset(roles)
        coordinate = coordinate_check(
            sample["artifacts"], ("input_rgba_with_full_alpha", "back_target"))
        sample["coordinate_check"] = coordinate
        sample["coordinate_compatible"] = bool(
            sample["complete"] and coordinate["same_canvas"])
        metadata = sample["metadata"]
        if metadata.get("has_back") is False or metadata.get("family") == "gem":
            sample["asset_type"] = "gemstone"
        if metadata.get("target_source"):
            sample["target_source"] = str(metadata["target_source"])
        # finish_sample ran before the final metadata assignment in artifact scanning.
        identity, kind = source_identity(sample)
        sample["source_identity"] = identity
        sample["source_identity_kind"] = kind
    return samples


def scan_source_images(spec: dict[str, Any], root: Path,
                       inspector: ArtifactInspector) -> list[dict[str, Any]]:
    iterator = root.rglob("*") if spec.get("recursive") else root.iterdir()
    samples = []
    for path in sorted(path for path in iterator
                       if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES):
        relative = path.relative_to(root)
        case_id = relative.with_suffix("").as_posix().replace("/", ":")
        design_id = relative.parent.as_posix() if relative.parent != Path(".") else path.stem
        artifact = inspector.inspect(path, "source_image")
        source_category = relative.parts[0] if len(relative.parts) > 1 else None
        sample = finish_sample({
            "sample_id": f"{spec['id']}:{case_id}",
            "case_id": case_id,
            "dataset_id": spec["id"],
            "design_id": design_id,
            "asset_type": spec["asset_type"],
            "provenance": spec["provenance"],
            "routing": spec["routing"],
            "complete": True,
            "coordinate_compatible": None,
            "metadata": {"source_category": source_category},
            "artifacts": [artifact],
        })
        samples.append(sample)
    return samples


def scan_manifest_cases(spec: dict[str, Any], manifest_path: Path,
                        inspector: ArtifactInspector) -> list[dict[str, Any]]:
    manifest = json.loads(manifest_path.read_text())
    samples = []
    for case in manifest.get("cases", []):
        image_record = case.get("image") or {}
        relative = image_record.get("file")
        if case.get("status") != "ok" or not relative:
            continue
        path = manifest_path.parent / relative
        if not path.is_file():
            continue
        artifact = inspector.inspect(path, "source_image")
        metadata = {
            "snapshot_id": manifest.get("snapshot_id"),
            "declared_source_sha256": image_record.get("sha256"),
            "source_sha256": image_record.get("sha256"),
            "selected_configuration": case.get("selected", {}),
        }
        samples.append(finish_sample({
            "sample_id": f"{spec['id']}:{case['id']}",
            "case_id": case["id"],
            "dataset_id": spec["id"],
            "design_id": case["id"],
            "asset_type": spec["asset_type"],
            "provenance": spec["provenance"],
            "routing": spec["routing"],
            "complete": True,
            "coordinate_compatible": None,
            "metadata": metadata,
            "artifacts": [artifact],
        }))
    return samples


SCANNERS = {
    "pair_dirs": scan_pair_dirs,
    "editor_triples": scan_editor_triples,
    "artifact_dirs": scan_artifact_dirs,
    "cache_dirs": scan_cache_dirs,
    "source_images": scan_source_images,
    "manifest_cases": scan_manifest_cases,
}


def load_run_manifests(config: dict[str, Any], repo: Path) -> list[dict[str, Any]]:
    paths: set[Path] = set()
    for pattern in config.get("run_manifest_globs", []):
        paths.update(repo.glob(pattern))
    records = []
    for path in sorted(paths):
        metadata, error = read_metadata(path)
        record = {
            "path": path.relative_to(repo).as_posix(),
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
        }
        if error:
            record["error"] = error
        else:
            record.update({
                "schema": metadata.get("schema", metadata.get("schema_version")),
                "created_at": metadata.get("created_at"),
                "fingerprint": metadata.get("fingerprint"),
                "args": metadata.get("args", {}),
                "train_designs": metadata.get("train_designs", []),
                "val_designs": metadata.get("val_designs", []),
                "hard_negative_ids": metadata.get("hard_negative_ids", []),
                "architecture": metadata.get("architecture"),
                "release": metadata.get("release"),
                "source_checkpoint": metadata.get("source_checkpoint"),
                "checkpoint_sha256": metadata.get("checkpoint_sha256"),
                "onnx_sha256": metadata.get("onnx_sha256"),
                "snapshot_id": metadata.get("snapshot_id"),
                "source_export_sha256": metadata.get("source_export_sha256"),
                "selection_sha256": metadata.get("selection_sha256"),
                "correction_manifest_sha256": metadata.get(
                    "correction_manifest_sha256"),
                "snapshot_manifest_sha256": metadata.get(
                    "snapshot_manifest_sha256"),
                "counts": metadata.get("counts"),
                "teacher_model_sha256": metadata.get("teacher_model_sha256"),
                "baseline_model_sha256": metadata.get("baseline_model_sha256"),
                "case_count": len(metadata.get("cases", []))
                if isinstance(metadata.get("cases"), list) else None,
                "top_level_keys": sorted(metadata),
            })
        records.append(record)
    return records


def path_contains(root: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def apply_production_exposure(samples: list[dict[str, Any]], datasets: list[dict[str, Any]],
                              config: dict[str, Any], repo: Path,
                              trash: Path) -> dict[str, Any]:
    dataset_paths = {
        dataset["id"]: resolve_location(dataset, repo, trash) for dataset in datasets
    }
    direct_train: set[str] = set()
    direct_select: set[str] = set()
    direct_train_cases: set[str] = set()
    direct_select_cases: set[str] = set()
    declared_dataset_ids: set[str] = set()
    lineage_records = []
    for lineage in config.get("production_lineage", []):
        split_path = repo / lineage["split"]
        split = json.loads(split_path.read_text())
        args = split.get("args", {})
        main = repo / args["data"] if args.get("data") else None
        extras = [repo / path for path in (args.get("extra_data") or [])]
        train_designs = set(split.get("train_designs", []))
        val_designs = set(split.get("val_designs", []))
        counts = Counter()
        for sample in samples:
            sample_root = dataset_paths[sample["dataset_id"]]
            role = None
            if main is not None and path_contains(main, sample_root):
                declared_dataset_ids.add(sample["dataset_id"])
                if lineage.get("final_fit_all"):
                    role = "train_and_training_monitor"
                elif sample["design_id"] in train_designs:
                    role = "train"
                elif sample["design_id"] in val_designs:
                    role = "checkpoint_selection"
                else:
                    role = "unknown_within_declared_dataset"
            for extra in extras:
                if path_contains(extra, sample_root):
                    declared_dataset_ids.add(sample["dataset_id"])
                    if sample_root.name == "holdout" or "holdout" in sample_root.parts:
                        role = "checkpoint_selection"
                    else:
                        role = "train"
            if role is None:
                continue
            sample.setdefault("direct_production_lineage", []).append({
                "component": lineage["component"],
                "run": lineage["run"],
                "role": role,
            })
            counts[role] += 1
            identity = sample.get("source_identity")
            if role in ("train", "train_and_training_monitor"):
                if identity:
                    direct_train.add(identity)
                direct_train_cases.add(sample["lineage_case_key"])
            if role in ("checkpoint_selection", "train_and_training_monitor"):
                if identity:
                    direct_select.add(identity)
                direct_select_cases.add(sample["lineage_case_key"])
        lineage_records.append({
            **lineage,
            "split_sha256": sha256_file(split_path),
            "data": args.get("data"),
            "extra_data": args.get("extra_data") or [],
            "fingerprint": split.get("fingerprint"),
            "matched_sample_roles": dict(sorted(counts.items())),
        })

    for sample in samples:
        identity = sample.get("source_identity")
        training_by_hash = bool(identity and identity in direct_train)
        selection_by_hash = bool(identity and identity in direct_select)
        training_by_case = sample["lineage_case_key"] in direct_train_cases
        selection_by_case = sample["lineage_case_key"] in direct_select_cases
        training = training_by_hash or training_by_case
        selection = selection_by_hash or selection_by_case
        exposure_known = training or selection or sample["dataset_id"] in declared_dataset_ids
        sample["production_training_exposure"] = training if exposure_known else "unknown"
        sample["production_selection_exposure"] = selection if exposure_known else "unknown"
        sample["production_exposure"] = (training or selection) if exposure_known else "unknown"
        reasons = []
        if training:
            reasons.append(
                "Source hash or recorded case lineage occurs in deployed-model training.")
        if selection:
            reasons.append(
                "Source hash or recorded case lineage occurs in deployed checkpoint selection/monitoring.")
        if reasons:
            sample["frozen_test_exclusion"] = reasons
        elif not exposure_known:
            sample["frozen_test_exclusion"] = [
                "Production exposure cannot be disproved from recovered lineage."
            ]
        elif sample["routing"] in {
                "awaiting_editor_native_v2", "awaiting_two_independent_editors"}:
            sample["frozen_test_exclusion"] = [
                "No accepted native v2 ground truth exists yet."
            ]
        else:
            sample["frozen_test_exclusion"] = [
                "Provenance/routing is not eligible for clean frozen-test truth."
            ]
    return {
        "lineage": lineage_records,
        "training_source_identities": len(direct_train),
        "selection_source_identities": len(direct_select),
        "any_exposed_source_identities": len(direct_train | direct_select),
        "training_case_keys": len(direct_train_cases),
        "selection_case_keys": len(direct_select_cases),
        "declared_dataset_ids": sorted(declared_dataset_ids),
    }


def apply_contamination_evidence(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Propagate non-production contamination using hashes and recorded case lineage."""

    evidence: dict[str, tuple[set[str], set[str]]] = {
        "dense_label": (set(), set()),
        "sparse_correction": (set(), set()),
        "refiner": (set(), set()),
        "benchmark": (set(), set()),
    }

    def add(kind: str, sample: dict[str, Any]) -> None:
        identities, cases = evidence[kind]
        if sample.get("source_identity"):
            identities.add(sample["source_identity"])
        cases.add(sample["lineage_case_key"])

    for sample in samples:
        roles = {artifact["role"] for artifact in sample.get("artifacts", [])}
        dense = sample["complete"] and (
            {"full_target", "front_target"}.issubset(roles) or
            {"input_rgba_with_full_alpha", "back_target"}.issubset(roles)
        )
        correction = (
            sample["provenance"] in {
                "reviewed_model_correction", "sparse_reviewed_model_edit"
            } or
            "correction" in sample.get("target_source", "")
        )
        refiner = sample["routing"] == "v1_refiner_only"
        benchmark = (
            sample["provenance"] == "benchmark_source_copy" or
            sample["dataset_id"].startswith("benchmark-") or
            bool(sample.get("metadata", {}).get("snapshot_id"))
        )
        if dense:
            add("dense_label", sample)
        if correction:
            add("sparse_correction", sample)
        if refiner:
            add("refiner", sample)
        if benchmark:
            add("benchmark", sample)

    for sample in samples:
        identity = sample.get("source_identity")
        case_key = sample["lineage_case_key"]

        def matched(kind: str) -> bool:
            identities, cases = evidence[kind]
            return bool((identity and identity in identities) or case_key in cases)

        sample["seen_by_production"] = sample["production_exposure"]
        sample["seen_as_dense_label"] = True if matched("dense_label") else "unknown"
        sample["seen_as_sparse_correction"] = (
            True if matched("sparse_correction") else "unknown")
        sample["seen_by_refiner"] = True if matched("refiner") else "unknown"
        sample["benchmark_member"] = matched("benchmark")
        sample["eligible_for_frozen_test"] = sample["frozen_test_eligible"]
        sample["exclusion_reasons"] = list(sample["frozen_test_exclusion"])

    return {
        kind: {"source_identities": len(values[0]), "case_keys": len(values[1])}
        for kind, values in evidence.items()
    }


def correction_exports(config: dict[str, Any], repo: Path,
                       trash: Path) -> list[dict[str, Any]]:
    records = []
    for item in config.get("correction_exports", []):
        path = resolve_location(item, repo, trash)
        record = {
            **item,
            "resolved_path": relative_display(path, repo, trash),
            "exists": path.is_file(),
        }
        if path.is_file():
            record.update({"bytes": path.stat().st_size, "sha256": sha256_file(path)})
            metadata, error = read_metadata(path)
            if error:
                record["parse_error"] = error
            else:
                record["schema"] = metadata.get("schema", metadata.get("schema_version"))
                for key in ("cases", "decisions", "corrections", "selected"):
                    value = metadata.get(key)
                    if isinstance(value, (list, dict)):
                        record[f"{key}_count"] = len(value)
                record["top_level_keys"] = sorted(metadata)
        records.append(record)
    return records


def archive_records(config: dict[str, Any], repo: Path,
                    trash: Path) -> list[dict[str, Any]]:
    records = []
    for item in config.get("archives", []):
        path = resolve_location(item, repo, trash)
        record = {**item, "resolved_path": relative_display(path, repo, trash),
                  "exists": path.is_file()}
        if path.is_file():
            record.update({"bytes": path.stat().st_size, "sha256": sha256_file(path)})
            try:
                with zipfile.ZipFile(path) as archive:
                    entries = sorted(archive.infolist(), key=lambda entry: entry.filename)
                    record.update({
                        "entry_count": len(entries),
                        "uncompressed_bytes": sum(entry.file_size for entry in entries),
                        "content_index_sha256": sha256_json([
                            [entry.filename, entry.file_size, entry.CRC] for entry in entries
                        ]),
                        "entries": [entry.filename for entry in entries],
                    })
            except (OSError, zipfile.BadZipFile) as error:
                record["archive_error"] = str(error)
        records.append(record)
    return records


def duplicate_groups(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        if sample.get("source_identity"):
            groups[sample["source_identity"]].append(sample)
    return [
        {
            "source_identity": identity,
            "occurrences": len(items),
            "dataset_ids": sorted({item["dataset_id"] for item in items}),
            "sample_ids": sorted(item["sample_id"] for item in items),
            "production_exposure": any(item["production_exposure"] is True for item in items),
        }
        for identity, items in sorted(groups.items()) if len(items) > 1
    ]


def pixel_duplicate_groups(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, set[str]] = defaultdict(set)
    paths: dict[str, set[str]] = defaultdict(set)
    for sample in samples:
        for artifact in sample.get("artifacts", []):
            pixel_hash = artifact.get("image", {}).get("pixel_sha256")
            if pixel_hash:
                groups[pixel_hash].add(sample["sample_id"])
                paths[pixel_hash].add(artifact["path"])
    return [
        {
            "pixel_sha256": digest,
            "sample_occurrences": len(items),
            "file_paths": sorted(paths[digest]),
            "sample_ids": sorted(items),
        }
        for digest, items in sorted(groups.items()) if len(paths[digest]) > 1
    ]


def summarize_datasets(datasets: list[dict[str, Any]],
                       samples: list[dict[str, Any]]) -> None:
    by_dataset: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        by_dataset[sample["dataset_id"]].append(sample)
    for dataset in datasets:
        items = by_dataset[dataset["id"]]
        dataset["sample_count"] = len(items)
        dataset["complete_samples"] = sum(item["complete"] for item in items)
        dataset["incomplete_samples"] = sum(not item["complete"] for item in items)
        dataset["coordinate_compatible_samples"] = sum(
            item["coordinate_compatible"] is True for item in items)
        dataset["coordinate_incompatible_samples"] = sum(
            item["coordinate_compatible"] is False for item in items)
        dataset["production_exposed_samples"] = sum(
            item["production_exposure"] is True for item in items)
        dataset["production_unexposed_samples"] = sum(
            item["production_exposure"] is False for item in items)
        dataset["production_exposure_unknown_samples"] = sum(
            item["production_exposure"] == "unknown" for item in items)
        dataset["dense_label_exposed_samples"] = sum(
            item["seen_as_dense_label"] is True for item in items)
        dataset["sparse_correction_exposed_samples"] = sum(
            item["seen_as_sparse_correction"] is True for item in items)
        dataset["refiner_exposed_samples"] = sum(
            item["seen_by_refiner"] is True for item in items)
        dataset["benchmark_member_samples"] = sum(
            item["benchmark_member"] for item in items)
        dataset["unique_source_identities"] = len({
            item["source_identity"] for item in items if item.get("source_identity")
        })
        dataset["target_sources"] = dict(sorted(Counter(
            item.get("target_source", "unspecified") for item in items).items()))


def find_untraceable(datasets: list[dict[str, Any]],
                     samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for dataset in datasets:
        if not dataset["exists"]:
            records.append({
                "kind": "missing_configured_dataset",
                "dataset_id": dataset["id"],
                "path": dataset["resolved_path"],
            })
        if dataset.get("scan_error"):
            records.append({
                "kind": "dataset_scan_error",
                "dataset_id": dataset["id"],
                "path": dataset["resolved_path"],
                "error": dataset["scan_error"],
            })
    for sample in samples:
        reasons = []
        if not sample.get("source_identity"):
            reasons.append("missing_source_identity")
        if not sample["complete"]:
            reasons.append("incomplete_expected_artifacts")
        decode_errors = [
            artifact["path"] for artifact in sample.get("artifacts", [])
            if artifact.get("decode_error")
        ]
        if decode_errors:
            reasons.append("image_decode_error")
        if reasons:
            records.append({
                "kind": "sample_traceability_issue",
                "sample_id": sample["sample_id"],
                "reasons": reasons,
                "decode_error_paths": decode_errors,
            })
    return records


def summary_markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    rows = []
    for dataset in report["datasets"]:
        rows.append(
            f"| `{dataset['id']}` | {dataset['sample_count']} | "
            f"{dataset['complete_samples']} | {dataset['coordinate_incompatible_samples']} | "
            f"{dataset['production_exposed_samples']} | "
            f"{dataset['production_exposure_unknown_samples']} | `{dataset['routing']}` |")
    return """# Ring v2 provenance inventory

This is an inventory, not a training allow-list. No sample is promoted to clean
validation or frozen test by this report.

## Summary

""" + "\n".join([
        f"- Dataset occurrences: {summary['datasets']}",
        f"- Sample occurrences: {summary['sample_occurrences']}",
        f"- Unique source identities: {summary['unique_source_identities']}",
        f"- Production-exposed occurrences: {summary['production_exposed_samples']}",
        "- Production-unexposed occurrences proved by recovered lineage: "
        f"{summary['production_unexposed_samples']}",
        "- Production exposure unknown: "
        f"{summary['production_exposure_unknown_samples']}",
        f"- Exact duplicate source groups: {summary['exact_duplicate_source_groups']}",
        f"- Coordinate-incompatible labelled occurrences: {summary['coordinate_incompatible_samples']}",
        f"- Untraceable records: {summary['untraceable_records']}",
        f"- Frozen-test eligible now: {summary['frozen_test_eligible_samples']}",
    ]) + """

## Dataset occurrences

| Dataset | Samples | Complete | Bad canvas | Production-exposed | Exposure unknown | Routing |
|---|---:|---:|---:|---:|---:|---|
""" + "\n".join(rows) + """

## Interpretation

- `legacy_retoucher_pair` is useful only after native compatibility QA; independently
  trimmed full/front canvases are not direct v2 ownership truth.
- Teacher, correction and refiner datasets encode outputs or edits from a particular
  production pipeline. They are diagnostic or warm-start material, never frozen truth.
- Every source seen in deployed training or checkpoint selection is excluded from a
  clean frozen test.
- Near-duplicate visual grouping is intentionally deferred to Stage 0.5; this report
  provides the exact hashes and design metadata needed for that pass.
"""


def build_inventory(config_path: Path, repo: Path, trash: Path,
                    output: Path) -> dict[str, Any]:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite inventory: {output}")
    summary_path = output.with_suffix(".summary.md")
    seal_path = output.with_suffix(".sha256")
    if summary_path.exists() or seal_path.exists():
        raise FileExistsError("refusing to overwrite inventory sidecar")
    config = json.loads(config_path.read_text())
    inspector = ArtifactInspector(repo, trash)
    datasets = []
    samples: list[dict[str, Any]] = []
    for index, spec in enumerate(config["datasets"], 1):
        root = resolve_location(spec, repo, trash)
        dataset = {
            **spec,
            "resolved_path": relative_display(root, repo, trash),
            "exists": root.exists(),
        }
        print(f"[{index:02d}/{len(config['datasets']):02d}] {spec['id']}", flush=True)
        if root.exists():
            try:
                found = SCANNERS[spec["scanner"]](spec, root, inspector)
                samples.extend(found)
            except Exception as error:
                dataset["scan_error"] = f"{type(error).__name__}: {error}"
        datasets.append(dataset)

    run_records = load_run_manifests(config, repo)
    exposure = apply_production_exposure(samples, datasets, config, repo, trash)
    contamination = apply_contamination_evidence(samples)
    summarize_datasets(datasets, samples)
    duplicates = duplicate_groups(samples)
    pixel_duplicates = pixel_duplicate_groups(samples)
    untraceable = find_untraceable(datasets, samples)
    summary = {
        "datasets": len(datasets),
        "datasets_present": sum(dataset["exists"] for dataset in datasets),
        "datasets_with_scan_errors": sum("scan_error" in dataset for dataset in datasets),
        "sample_occurrences": len(samples),
        "complete_samples": sum(sample["complete"] for sample in samples),
        "incomplete_samples": sum(not sample["complete"] for sample in samples),
        "coordinate_compatible_samples": sum(
            sample["coordinate_compatible"] is True for sample in samples),
        "coordinate_incompatible_samples": sum(
            sample["coordinate_compatible"] is False for sample in samples),
        "unique_source_identities": len({
            sample["source_identity"] for sample in samples if sample.get("source_identity")
        }),
        "production_exposed_samples": sum(
            sample["production_exposure"] is True for sample in samples),
        "production_unexposed_samples": sum(
            sample["production_exposure"] is False for sample in samples),
        "production_exposure_unknown_samples": sum(
            sample["production_exposure"] == "unknown" for sample in samples),
        "dense_label_exposed_samples": sum(
            sample["seen_as_dense_label"] is True for sample in samples),
        "sparse_correction_exposed_samples": sum(
            sample["seen_as_sparse_correction"] is True for sample in samples),
        "refiner_exposed_samples": sum(
            sample["seen_by_refiner"] is True for sample in samples),
        "benchmark_member_samples": sum(
            sample["benchmark_member"] for sample in samples),
        "frozen_test_eligible_samples": sum(
            sample["frozen_test_eligible"] for sample in samples),
        "exact_duplicate_source_groups": len(duplicates),
        "decoded_pixel_duplicate_groups": len(pixel_duplicates),
        "untraceable_records": len(untraceable),
        "physical_file_reads": inspector.file_reads,
        "hardlink_cache_hits": inspector.hardlink_cache_hits,
        "provenance_counts": dict(sorted(Counter(
            sample["provenance"] for sample in samples).items())),
        "routing_counts": dict(sorted(Counter(
            sample["routing"] for sample in samples).items())),
        "asset_type_counts": dict(sorted(Counter(
            sample["asset_type"] for sample in samples).items())),
    }
    report = {
        "schema": "jewelsense.ring-v2-provenance-inventory/v1",
        "inventory_id": config["inventory_id"],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repo": str(repo.resolve()),
        "trash": str(trash.resolve()),
        "config": config_path.relative_to(repo).as_posix(),
        "config_sha256": sha256_file(config_path),
        "generator": {
            "path": relative_display(Path(__file__).resolve(), repo, trash),
            "sha256": sha256_file(Path(__file__).resolve()),
        },
        "read_only_scan": True,
        "automatic_training_admission": False,
        "near_duplicate_grouping_complete": False,
        "summary": summary,
        "production_lineage": exposure,
        "contamination_evidence": contamination,
        "datasets": datasets,
        "samples": sorted(samples, key=lambda sample: sample["sample_id"]),
        "exact_duplicate_source_groups": duplicates,
        "decoded_pixel_duplicate_groups": pixel_duplicates,
        "untraceable_artifacts": untraceable,
        "run_manifests": run_records,
        "correction_exports": correction_exports(config, repo, trash),
        "archives": archive_records(config, repo, trash),
        "limitations": [
            "Exact hashes do not replace Stage 0.5 visual near-duplicate grouping.",
            "Legacy pair coordinate compatibility checks canvas equality only; semantic alignment still needs audit.",
            "Absence from recovered run manifests is reported as unknown, not proof that an old model never saw a source.",
            "Validator suitability labels are not segmentation ground truth.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=output.parent,
                                     prefix=f".{output.name}.", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(report, stream, indent=2, sort_keys=True)
        stream.write("\n")
    temporary.replace(output)
    summary_path.write_text(summary_markdown(report))
    seal_path.write_text(sha256_file(output) + "  " + output.name + "\n")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path,
                        default=Path("ring_v2/config/inventory.json"))
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--trash", type=Path,
                        default=Path.home() / ".local/share/Trash/files")
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = build_inventory(args.config.resolve(), args.repo.resolve(),
                             args.trash.resolve(), args.out.resolve())
    summary = report["summary"]
    print(
        f"[✓] {summary['sample_occurrences']} occurrences / "
        f"{summary['unique_source_identities']} source identities / "
        f"{summary['production_exposed_samples']} production-exposed")


if __name__ == "__main__":
    main()
