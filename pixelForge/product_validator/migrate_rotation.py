"""Add explicit in-plane rotation labels to a legacy validator manifest."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .isolation import HERE, safe_output
from .manifest import load_manifest


def legacy_rotation(labels: dict) -> str | None:
    """Return the safe orientation default for labels created pre-rotation."""
    if labels.get("asset") in ("ring", "gemstone") and labels.get("view"):
        return "none"
    return None


def migrate(manifest_path: Path, output: Path) -> dict:
    manifest = load_manifest(manifest_path.resolve())
    added = 0
    for case in manifest["cases"]:
        labels = case["labels"]
        if "rotation" not in labels:
            labels["rotation"] = legacy_rotation(labels)
            added += 1
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    manifest["last_migration"] = {
        "name": "explicit_rotation_label",
        "cases_updated": added,
    }
    output = safe_output(output, HERE / "data")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2) + "\n")
    return {"output": str(output), "cases_updated": added,
            "case_count": len(manifest["cases"])}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument(
        "--output",
        default="product_validator/data/review_ready_manifest.json")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    print(json.dumps(migrate(Path(args.manifest), Path(args.output)), indent=2))


if __name__ == "__main__":
    main()
