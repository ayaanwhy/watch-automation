#!/usr/bin/env python3
"""Create an immutable, content-addressed benchmark snapshot of local images."""

import argparse
import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path


SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def slug(value):
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value or "image"


def discover(inputs):
    files = []
    for raw in inputs:
        path = Path(raw).resolve()
        if path.is_dir():
            files.extend(item for item in path.iterdir()
                         if item.is_file() and item.suffix.lower() in SUFFIXES)
        elif path.is_file() and path.suffix.lower() in SUFFIXES:
            files.append(path)
        else:
            raise FileNotFoundError(f"unsupported image input: {path}")
    return sorted(set(files), key=lambda item: (item.name.lower(), str(item)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--snapshot-id", required=True)
    parser.add_argument("--asset-type", choices=("ring", "gemstone"),
                        default="gemstone")
    parser.add_argument("--parent-name", action="store_true",
                        help="derive case IDs from parent directories (for repeated source.jpg)")
    parser.add_argument("--out-root", default="benchmark/snapshots")
    args = parser.parse_args()

    files = discover(args.inputs)
    if not files:
        raise ValueError("no supported images found")
    root = Path(args.out_root).resolve()
    target = root / args.snapshot_id
    partial = root / f".{args.snapshot_id}.partial"
    if target.exists() or partial.exists():
        raise FileExistsError(f"immutable snapshot path already exists: {target}")
    (partial / "images").mkdir(parents=True)

    cases = []
    used_ids = {}
    for source in files:
        digest = sha256_file(source)
        suffix = source.suffix.lower()
        relative = Path("images") / f"{digest}{suffix}"
        destination = partial / relative
        if not destination.exists():
            shutil.copyfile(source, destination)
        base_id = slug(source.parent.name if args.parent_name else source.stem)
        used_ids[base_id] = used_ids.get(base_id, 0) + 1
        case_id = (base_id if used_ids[base_id] == 1
                   else f"{base_id}-{used_ids[base_id]}")
        cases.append({
            "id": case_id,
            "status": "ok",
            "asset_type": args.asset_type,
            "selected": {
                "Asset type": "Gemstone" if args.asset_type == "gemstone" else "Ring",
                "Source file": source.name,
            },
            "image": {
                "file": str(relative),
                "sha256": digest,
                "bytes": source.stat().st_size,
                "content_type": CONTENT_TYPES[suffix],
            },
        })

    manifest = {
        "schema_version": 1,
        "snapshot_id": args.snapshot_id,
        "asset_type": args.asset_type,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": {"kind": "local_images",
                   "inputs": [str(Path(value).resolve()) for value in args.inputs]},
        "cases": cases,
    }
    (partial / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    root.mkdir(parents=True, exist_ok=True)
    os.replace(partial, target)
    print(target / "manifest.json")
    print(f"saved {len(cases)} immutable {args.asset_type} cases")


if __name__ == "__main__":
    main()
