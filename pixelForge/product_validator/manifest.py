"""Build and audit a portable, duplicate-safe validator manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .taxonomy import SCHEMA_VERSION, readiness, validate_case


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
HERE = Path(__file__).resolve().parent


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_ring_group(case: dict) -> str:
    requested = case.get("requested", {})
    excluded = {
        "Center diamond type", "Center stone size", "Center stone shape",
        "Ring head metal", "Mounting metal", "Side stones type",
    }
    physical = {key: requested[key] for key in sorted(requested)
                if key not in excluded}
    if physical:
        payload = json.dumps(physical, sort_keys=True, separators=(",", ":"))
        return "ring-family:" + hashlib.sha256(payload.encode()).hexdigest()[:20]
    return "ring-case:" + str(case["id"])


def _relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _case(case_id: str, path: Path, root: Path, source: str,
          group_id: str, labels: dict, label_source: str) -> dict:
    return {
        "id": case_id,
        "image": _relative(path, root),
        "sha256": sha256_file(path),
        "group_id": group_id,
        "source": source,
        "labels": labels,
        "label_source": label_source,
    }


def seed_cases(repo_root: Path) -> list[dict]:
    """Collect trusted positives without inventing missing view labels."""
    cases = []
    ring_manifest = repo_root / (
        "benchmark/snapshots/buchroeders-ultimate-v1-20260827-v5/manifest.json")
    if ring_manifest.is_file():
        payload = json.loads(ring_manifest.read_text())
        snapshot_root = ring_manifest.parent
        for item in payload.get("cases", []):
            image = item.get("image") or {}
            path = snapshot_root / image.get("file", "")
            if item.get("status") != "ok" or not path.is_file():
                continue
            cases.append(_case(
                "ring:" + str(item["id"]), path, repo_root,
                "reviewed_ring_benchmark", _stable_ring_group(item),
                {"asset": "ring", "view": "front", "suitable": True,
                 "rotation": "none", "quality": []},
                "trusted_existing_benchmark"))

    # These photographs are known loose gemstones, but camera-angle and
    # suitability labels have not been reviewed for the validator task.
    gem_roots = (
        (repo_root / "rings/gems-raw", "gemstone_raw"),
        (repo_root / "configurator/public/gems", "gemstone_catalogue_crop"),
    )
    for folder, source in gem_roots:
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            if path.suffix.lower() not in IMAGE_SUFFIXES:
                continue
            sku = path.stem
            cases.append(_case(
                f"gemstone:{source}:{sku}", path, repo_root, source,
                "gemstone-sku:" + sku,
                {"asset": "gemstone", "view": None, "rotation": None,
                 "suitable": None, "quality": None},
                "known_product_type_only"))

    # Recovered from the deleted segmentation training tree.  `full.png` is
    # the complete product; `front.png` is an ownership target and must never
    # be used by the input validator.  The main `pairs.json` collection is a
    # ring-only catalogue (all source IDs contain the ring marker `-R-`).
    recovered = repo_root / "product_validator/data/recovered_20260902"
    pair_index = recovered / "pairs.json"
    pair_root = recovered / "pairs"
    if pair_index.is_file() and pair_root.is_dir():
        for item in json.loads(pair_index.read_text()):
            sku = str(item["id"])
            if "-R-" not in sku:
                raise ValueError(
                    f"recovered ring set contains an unexpected SKU: {sku}")
            path = pair_root / sku / "full.png"
            if path.is_file():
                cases.append(_case(
                    f"ring:recovered:{sku}", path, repo_root,
                    "recovered_segmentation_ring_pairs",
                    "recovered-ring-sku:" + sku,
                    {"asset": "ring", "view": "front", "suitable": True,
                     "rotation": "none", "quality": []},
                    "trusted_ring_only_source"))

    # The Talla collection is a known ring training source, but it contains
    # extreme top views whose suitability cannot be assigned automatically.
    # Preserve the known asset type and require review for the remaining facts.
    talla_index = recovered / "pairs_talla.json"
    talla_root = recovered / "pairs_talla"
    if talla_index.is_file() and talla_root.is_dir():
        for item in json.loads(talla_index.read_text()):
            sku = str(item["id"])
            path = talla_root / sku / "full.png"
            if path.is_file():
                cases.append(_case(
                    f"review:talla:{sku}", path, repo_root,
                    "recovered_talla_pairs", "recovered-talla-sku:" + sku,
                    {"asset": "ring", "view": None, "rotation": None,
                     "suitable": None, "quality": None},
                    "known_ring_source_requires_view_review"))

    # Only cache entries carrying generation metadata are eligible.  The
    # remaining historical cache has no reliable provenance and is ignored.
    cache_root = repo_root / "product_validator/data/recovered_cache_20260902"
    if cache_root.is_dir():
        for metadata_path in sorted(cache_root.glob("*/meta.json")):
            metadata = json.loads(metadata_path.read_text())
            path = metadata_path.parent / "img.png"
            if not path.is_file():
                continue
            source = metadata.get("source")
            family = metadata.get("family")
            design = str(metadata.get("design_id") or metadata_path.parent.name)
            if source == "synthetic_single" and family == "gem":
                labels = {"asset": "gemstone", "view": "front",
                          "rotation": "none", "suitable": True,
                          "quality": []}
                label_source = "metadata_generated_single_gem"
            elif source == "synthetic_multi" and family == "gem":
                labels = {"asset": "gemstone", "view": "front",
                          "rotation": "none", "suitable": False,
                          "quality": ["multiple_products"]}
                label_source = "metadata_generated_multi_gem"
            elif source in {"original_jpg", "edited_png"} and family != "gem":
                labels = {"asset": "ring", "view": "front",
                          "rotation": "none", "suitable": True,
                          "quality": []}
                label_source = "metadata_existing_ring_input"
            else:
                continue
            cases.append(_case(
                f"cache:{source}:{metadata_path.parent.name}", path, repo_root,
                f"recovered_cache_{source}", "cache-design:" + design,
                labels, label_source))
    return deduplicate(cases)


def deduplicate(cases: list[dict]) -> list[dict]:
    """Keep one byte-identical image and retain all source aliases."""
    def completeness(case):
        labels = case["labels"]
        return sum(labels.get(field) is not None for field in
                   ("asset", "view", "rotation", "suitable", "quality"))

    def alias(case):
        return {"id": case["id"], "image": case["image"],
                "source": case["source"], "group_id": case["group_id"]}

    def check_compatible(left, right):
        for field in ("asset", "view", "rotation", "suitable", "quality"):
            a = left["labels"].get(field)
            b = right["labels"].get(field)
            equal = (set(a) == set(b) if field == "quality" and
                     a is not None and b is not None else a == b)
            if a is not None and b is not None and not equal:
                raise ValueError(
                    f"conflicting {field} labels for byte-identical images: "
                    f"{left['id']} and {right['id']}")

    by_digest = {}
    for case in sorted(cases, key=lambda item: item["id"]):
        digest = case["sha256"]
        if digest not in by_digest:
            by_digest[digest] = case
            continue
        kept = by_digest[digest]
        check_compatible(kept, case)
        if completeness(case) > completeness(kept):
            primary, secondary = case, kept
        else:
            primary, secondary = kept, case
        merged = False
        for field in ("asset", "view", "rotation", "suitable", "quality"):
            if (primary["labels"].get(field) is None and
                    secondary["labels"].get(field) is not None):
                primary["labels"][field] = secondary["labels"][field]
                merged = True
        if merged:
            primary["label_source"] = "merged_duplicate_trusted_sources"
        aliases = list(primary.get("aliases", ()))
        aliases.append(alias(secondary))
        aliases.extend(secondary.get("aliases", ()))
        primary["aliases"] = aliases
        by_digest[digest] = primary
    return sorted(by_digest.values(), key=lambda item: item["id"])


def load_manifest(path: Path) -> dict:
    payload = json.loads(path.read_text())
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported validator manifest schema")
    if not isinstance(payload.get("cases"), list):
        raise ValueError("manifest cases must be a list")
    ids = set()
    digests = set()
    for case in payload["cases"]:
        validate_case(case)
        if case["id"] in ids:
            raise ValueError(f"duplicate case id: {case['id']}")
        if case["sha256"] in digests:
            raise ValueError(f"duplicate image digest: {case['sha256']}")
        ids.add(case["id"])
        digests.add(case["sha256"])
    return payload


def resolve_image(manifest_path: Path, manifest: dict, case: dict) -> Path:
    base = manifest_path.parent / manifest.get("path_base", ".")
    return (base / case["image"]).resolve()


def audit_manifest(path: Path) -> dict:
    manifest = load_manifest(path)
    missing = []
    changed = []
    for case in manifest["cases"]:
        image = resolve_image(path, manifest, case)
        if not image.is_file():
            missing.append(case["id"])
        elif sha256_file(image) != case["sha256"]:
            changed.append(case["id"])
    report = readiness(manifest["cases"])
    report.update({"missing_images": missing, "changed_images": changed})
    report["ready"] = report["ready"] and not missing and not changed
    return report


def write_seed(repo_root: Path, output: Path) -> dict:
    resolved = output.resolve()
    data_root = (HERE / "data").resolve()
    if resolved != data_root and data_root not in resolved.parents:
        raise ValueError(f"seed manifest must stay under {data_root}")
    output = resolved
    cases = seed_cases(repo_root)
    output.parent.mkdir(parents=True, exist_ok=True)
    path_base = os.path.relpath(repo_root.resolve(), output.parent.resolve())
    payload = {
        "schema_version": SCHEMA_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "path_base": Path(path_base).as_posix(),
        "cases": cases,
    }
    output.write_text(json.dumps(payload, indent=2) + "\n")
    return payload


def parse_args():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    seed = sub.add_parser("seed", help="build the initial positive manifest")
    seed.add_argument("--repo", default=".")
    seed.add_argument("--output", default="product_validator/data/seed_manifest.json")
    audit = sub.add_parser("audit", help="verify files, labels and readiness")
    audit.add_argument("--manifest", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    if args.command == "seed":
        payload = write_seed(Path(args.repo), Path(args.output))
        report = readiness(payload["cases"])
        print(json.dumps(report, indent=2))
    else:
        report = audit_manifest(Path(args.manifest))
        print(json.dumps(report, indent=2))
        if not report["ready"]:
            raise SystemExit(2)


if __name__ == "__main__":
    main()
