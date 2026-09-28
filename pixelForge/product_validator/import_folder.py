"""Append a labeled image folder to a validator manifest without copying it."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .isolation import HERE, safe_output
from .manifest import IMAGE_SUFFIXES, load_manifest, sha256_file
from .taxonomy import QUALITY_FLAGS, validate_case


def _choice(value: str):
    return None if value == "unknown" else value


def import_folder(manifest_path: Path, folder: Path, output: Path, *,
                  source: str, asset: str | None, view: str | None,
                  rotation: str | None,
                  suitable: bool | None, quality: list[str] | None,
                  group_by: str = "parent") -> dict:
    manifest_path = manifest_path.resolve()
    folder = folder.resolve()
    manifest = load_manifest(manifest_path)
    base = (manifest_path.parent / manifest.get("path_base", ".")).resolve()
    try:
        folder.relative_to(base)
    except ValueError as exc:
        raise ValueError(
            f"input folder must be under manifest path base {base}") from exc

    existing_ids = {case["id"] for case in manifest["cases"]}
    existing_digests = {case["sha256"] for case in manifest["cases"]}
    added = 0
    duplicates = 0
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        digest = sha256_file(path)
        if digest in existing_digests:
            duplicates += 1
            continue
        relative_folder = path.relative_to(folder).as_posix()
        case_id = f"import:{source}:{relative_folder}"
        if case_id in existing_ids:
            raise ValueError(f"generated duplicate case id: {case_id}")
        if group_by == "parent":
            group = path.parent.relative_to(folder).as_posix() or path.stem
        elif group_by == "stem":
            group = path.stem
        else:
            group = digest
        case = {
            "id": case_id,
            "image": path.relative_to(base).as_posix(),
            "sha256": digest,
            "group_id": f"import:{source}:{group}",
            "source": source,
            "labels": {"asset": asset, "view": view, "rotation": rotation,
                       "suitable": suitable, "quality": quality},
            "label_source": "folder_import_arguments",
        }
        validate_case(case)
        manifest["cases"].append(case)
        existing_ids.add(case_id)
        existing_digests.add(digest)
        added += 1
    manifest["cases"].sort(key=lambda case: case["id"])
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    manifest["last_import"] = {
        "source": source, "folder": str(folder), "added": added,
        "byte_duplicates_skipped": duplicates,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest["last_import"]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--folder", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--asset", choices=("ring", "gemstone", "other",
                                             "unknown"), default="unknown")
    parser.add_argument("--view", choices=("front", "side", "angled", "rear",
                                            "unknown"), default="unknown")
    parser.add_argument(
        "--rotation",
        choices=("none", "rotate_left", "rotate_right", "half_turn",
                 "unknown"),
        default="unknown")
    parser.add_argument("--suitable", choices=("yes", "no", "unknown"),
                        default="unknown")
    parser.add_argument(
        "--quality", default="unknown",
        help="unknown, none, or comma-separated quality flags")
    parser.add_argument("--group-by", choices=("parent", "stem", "hash"),
                        default="parent")
    parser.add_argument(
        "--output", default="product_validator/data/imported_manifest.json")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.quality == "unknown":
        quality = None
    elif args.quality == "none":
        quality = []
    else:
        quality = [value.strip() for value in args.quality.split(",")
                   if value.strip()]
        unknown = set(quality) - set(QUALITY_FLAGS)
        if unknown:
            raise SystemExit(f"unknown quality flags: {sorted(unknown)}")
    suitable = {"yes": True, "no": False, "unknown": None}[args.suitable]
    output = safe_output(Path(args.output), HERE / "data")
    report = import_folder(
        Path(args.manifest), Path(args.folder), output, source=args.source,
        asset=_choice(args.asset), view=_choice(args.view),
        rotation=_choice(args.rotation),
        suitable=suitable, quality=quality, group_by=args.group_by)
    print(json.dumps({"output": str(output), **report}, indent=2))


if __name__ == "__main__":
    main()
