"""Prepare the independent 40-case editor agreement workspace."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import shutil
import tempfile
import time
from typing import Any

import cv2
import numpy as np


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def fit_tile(image: np.ndarray, width: int, height: int) -> np.ndarray:
    scale = min(width / image.shape[1], height / image.shape[0])
    resized = cv2.resize(
        image, (max(1, round(image.shape[1] * scale)),
                max(1, round(image.shape[0] * scale))),
        interpolation=cv2.INTER_AREA)
    tile = np.full((height, width, 3), 238, np.uint8)
    y = (height - resized.shape[0]) // 2
    x = (width - resized.shape[1]) // 2
    tile[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return tile


def contact_sheet(cases: list[dict[str, Any]], source_dir: Path,
                  destination: Path) -> None:
    columns, tile_width, tile_height, label_height = 5, 240, 220, 42
    rows = (len(cases) + columns - 1) // columns
    sheet = np.full((rows * (tile_height + label_height),
                     columns * tile_width, 3), 32, np.uint8)
    for index, case in enumerate(cases):
        image = cv2.imread(str(source_dir / f"{case['case_id']}.jpg"))
        if image is None:
            raise ValueError(f"cannot decode {case['case_id']}")
        tile = fit_tile(image, tile_width, tile_height)
        row, column = divmod(index, columns)
        y, x = row * (tile_height + label_height), column * tile_width
        sheet[y:y + tile_height, x:x + tile_width] = tile
        name = case["case_id"]
        midpoint = min(len(name), 32)
        if len(name) > 32:
            split = name.rfind("-", 0, 32)
            midpoint = split if split > 10 else 32
        lines = (name[:midpoint], name[midpoint:].lstrip("-"))
        for line_index, line in enumerate(line for line in lines if line):
            cv2.putText(sheet, line, (x + 5, y + tile_height + 15 + line_index * 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.34, (235, 235, 235), 1,
                        cv2.LINE_AA)
    if not cv2.imwrite(str(destination), sheet,
                       [cv2.IMWRITE_JPEG_QUALITY, 92]):
        raise OSError(f"failed to write {destination}")


def instructions(selection_id: str, editor: str) -> str:
    return f"""# Ring v2 independent editor agreement — {editor}

Selection: `{selection_id}`

Label every source independently. Do not view another editor's files and do not use a
model-generated mask as a starting point.

For each `<case-id>.jpg`, return these two files in this lane's `returned/` folder:

```text
<case-id>;frontFullImage.png
<case-id>;frontImage.png
```

Rules:

- keep the exact 1000×1000 source canvas, orientation and pixel origin;
- save non-premultiplied RGBA PNG;
- full contains every visible ring pixel and no background/shadow;
- front contains only ring pixels that should render above a nominal finger;
- preserve thin prongs, small stones, antialiased edges and genuine open gaps;
- do not force the derived back layer to one component;
- do not invent parts missing from the source;
- if ownership is genuinely ambiguous, record the case ID and reason in `notes.txt`
  rather than silently choosing a prettier seam.

Follow the local `plans/ring-segmentation-v2/LABEL_CONTRACT.md` contract. Work through
`order.txt`; it is intentionally different for the two editors.
"""


def prepare(selection_path: Path, snapshot_manifest_path: Path,
            source_dir: Path, output: Path) -> dict[str, Any]:
    if output.exists():
        raise FileExistsError(f"refusing to overwrite agreement workspace: {output}")
    selection = json.loads(selection_path.read_text())
    snapshot = json.loads(snapshot_manifest_path.read_text())
    snapshot_cases = {case["id"]: case for case in snapshot["cases"]}
    configured = selection["cases"]
    if len(configured) != 40:
        raise ValueError(f"agreement selection must contain 40 cases, found {len(configured)}")
    case_ids = [case["case_id"] for case in configured]
    if len(set(case_ids)) != len(case_ids):
        raise ValueError("agreement selection contains duplicate case IDs")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        canonical = staging / "source"
        canonical.mkdir()
        records = []
        source_hashes = set()
        for item in configured:
            case_id = item["case_id"]
            if case_id not in snapshot_cases:
                raise ValueError(f"case is absent from snapshot: {case_id}")
            snapshot_case = snapshot_cases[case_id]
            if snapshot_case.get("status") != "ok":
                raise ValueError(f"case is not available in snapshot: {case_id}")
            source = source_dir / f"{case_id}.jpg"
            if not source.is_file():
                raise FileNotFoundError(f"agreement source is missing: {source}")
            source_hash = sha256_file(source)
            expected_hash = snapshot_case["image"]["sha256"]
            if source_hash != expected_hash:
                raise ValueError(f"source hash does not match snapshot: {case_id}")
            if source_hash in source_hashes:
                raise ValueError(f"agreement selection contains duplicate render: {case_id}")
            source_hashes.add(source_hash)
            target = canonical / source.name
            shutil.copy2(source, target)
            image = cv2.imread(str(target), cv2.IMREAD_UNCHANGED)
            if image is None:
                raise ValueError(f"cannot decode source: {case_id}")
            records.append({
                **item,
                "source_file": f"source/{source.name}",
                "source_sha256": source_hash,
                "width": int(image.shape[1]),
                "height": int(image.shape[0]),
                "snapshot_image_file": snapshot_case["image"]["file"],
                "selected_configuration": snapshot_case.get("selected", {}),
                "view": "front",
            })

        for lane_index, lane in enumerate(("editor-a", "editor-b")):
            lane_dir = staging / lane
            (lane_dir / "returned").mkdir(parents=True)
            order = case_ids.copy()
            random.Random(int(selection["seed"]) + lane_index * 104729).shuffle(order)
            (lane_dir / "order.txt").write_text("\n".join(order) + "\n")
            (lane_dir / "notes.txt").write_text(
                "# Record only genuine ambiguity or source defects.\n")
            (lane_dir / "README.md").write_text(
                instructions(selection["selection_id"], lane))

        contact_sheet(records, canonical, staging / "contact-sheet-source-only.jpg")
        manifest = {
            "schema_version": 1,
            "selection_id": selection["selection_id"],
            "label_contract": selection["label_contract"],
            "source_scope": selection.get("source_scope"),
            "coverage_limits": selection.get("coverage_limits", []),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "selection_sha256": sha256_file(selection_path),
            "snapshot_id": snapshot["snapshot_id"],
            "snapshot_manifest_sha256": sha256_file(snapshot_manifest_path),
            "source_count": len(records),
            "unique_source_hashes": len(source_hashes),
            "editor_lanes": ["editor-a", "editor-b"],
            "model_predictions_included": False,
            "cases": records,
        }
        write_json(staging / "manifest.json", manifest)
        (staging / "README.md").write_text(
            "# Independent ring-label agreement workspace\n\n"
            "This workspace contains 40 unique source renders and two independent editor "
            "lanes. Give each editor only the canonical source plus their own lane. Do not "
            "share returned masks before both lanes are complete. Model predictions are "
            "deliberately absent. Run the native-label auditor on each `returned/` folder "
            "before comparing agreement.\n")
        staging.rename(output)
        return manifest
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", type=Path,
                        default=Path("ring_v2/config/agreement_40.json"))
    parser.add_argument("--snapshot-manifest", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = prepare(
        args.selection.resolve(), args.snapshot_manifest.resolve(),
        args.source.resolve(), args.out.resolve())
    print(f"[✓] {manifest['source_count']} unique agreement cases -> {args.out}")


if __name__ == "__main__":
    main()
