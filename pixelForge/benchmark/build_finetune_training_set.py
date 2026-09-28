#!/usr/bin/env python3
"""Build an audited, leakage-safe correction set for ownership fine-tuning.

The newest reviewed training split takes precedence. Older reviewed training
cases are retained only when neither their case ID nor source image occurs in
the newest frozen selection. The output contains symlinks, so it is cheap to
rebuild and cannot silently copy stale labels over newer ones.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def case_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        raise ValueError(f"missing correction split: {root}")
    cases = sorted(path for path in root.iterdir() if path.is_dir())
    for case in cases:
        required = {"img.png", "back.png", "meta.json"}
        actual = {path.name for path in case.iterdir() if path.is_file()}
        missing = required - actual
        if missing:
            raise ValueError(f"{case} is missing {sorted(missing)}")
    return cases


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True,
                        help="newest materialized correction dataset")
    parser.add_argument("--previous", required=True,
                        help="older materialized correction dataset")
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    current = Path(args.current).resolve()
    previous = Path(args.previous).resolve()
    output = Path(args.out).resolve()
    if output.exists():
        raise ValueError(f"refusing to overwrite existing output: {output}")

    current_train = case_dirs(current / "train")
    current_holdout = case_dirs(current / "holdout")
    previous_train = case_dirs(previous / "train")
    current_all_ids = {case.name for case in current_train + current_holdout}
    holdout_hashes = {sha256(case / "img.png") for case in current_holdout}

    retained_previous = []
    excluded_previous = []
    for case in previous_train:
        reason = None
        image_hash = sha256(case / "img.png")
        if case.name in current_all_ids:
            reason = "case_id_present_in_current_selection"
        elif image_hash in holdout_hashes:
            reason = "source_image_matches_current_holdout"
        if reason:
            excluded_previous.append({"case_id": case.name, "reason": reason})
        else:
            retained_previous.append(case)

    output.mkdir(parents=True)
    selected = []
    for generation, cases in (("current", current_train),
                              ("previous", retained_previous)):
        for source in cases:
            destination = output / source.name
            if destination.exists():
                raise ValueError(f"duplicate correction case: {source.name}")
            destination.symlink_to(source, target_is_directory=True)
            selected.append({
                "case_id": source.name,
                "generation": generation,
                "source": str(source),
                "image_sha256": sha256(source / "img.png"),
                "back_sha256": sha256(source / "back.png"),
            })

    manifest = {
        "schema": "jewelsense.finetune-training-set/v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "current": str(current),
        "previous": str(previous),
        "current_train_count": len(current_train),
        "current_holdout_count": len(current_holdout),
        "retained_previous_train_count": len(retained_previous),
        "excluded_previous_train": excluded_previous,
        "selected": selected,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"built {output}: {len(current_train)} current + "
          f"{len(retained_previous)} previous = {len(selected)} cases")
    print(f"excluded {len(excluded_previous)} overlapping previous cases")


if __name__ == "__main__":
    main()
