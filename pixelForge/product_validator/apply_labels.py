"""Apply exported browser decisions to a new validator manifest."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .dataset import manifest_fingerprint
from .isolation import HERE, safe_output
from .manifest import load_manifest
from .taxonomy import DECISION_SCHEMA_VERSION, validate_labels


def apply_decisions(manifest_path: Path, decisions_path: Path | list[Path],
                    output: Path) -> dict:
    manifest = load_manifest(manifest_path)
    paths = ([decisions_path] if isinstance(decisions_path, Path) else
             list(decisions_path))
    if not paths:
        raise ValueError("at least one decisions file is required")
    expected_fingerprint = manifest_fingerprint(manifest)
    by_id = {case["id"]: case for case in manifest["cases"]}
    seen = set()
    for path in paths:
        payload = json.loads(path.read_text())
        if payload.get("schema_version") != DECISION_SCHEMA_VERSION:
            raise ValueError("unsupported decisions schema")
        if payload.get("manifest_fingerprint") != expected_fingerprint:
            raise ValueError(
                f"{path} was exported for a different manifest")
        for decision in payload.get("decisions", []):
            case_id = decision.get("id")
            if case_id in seen:
                raise ValueError(f"duplicate decision: {case_id}")
            if case_id not in by_id:
                raise ValueError(f"unknown decision case: {case_id}")
            case = by_id[case_id]
            if decision.get("sha256") != case["sha256"]:
                raise ValueError(f"image changed for decision: {case_id}")
            labels = decision.get("labels")
            validate_labels(labels)
            case["labels"] = labels
            case["label_source"] = "manual_validator_review"
            case["labeled_at"] = payload.get("created_at")
            seen.add(case_id)
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    manifest["applied_decision_count"] = len(seen)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument(
        "--decisions", required=True, action="append",
        help="exported decisions JSON; repeat for multiple review queues")
    parser.add_argument(
        "--output", default="product_validator/data/reviewed_manifest.json")
    return parser.parse_args()


def main():
    args = parse_args()
    output = safe_output(Path(args.output), HERE / "data")
    manifest = apply_decisions(
        Path(args.manifest).resolve(),
        [Path(value).resolve() for value in args.decisions], output)
    print(json.dumps({"output": str(output),
                      "applied": manifest["applied_decision_count"],
                      "fingerprint": manifest_fingerprint(manifest)}, indent=2))


if __name__ == "__main__":
    main()
