#!/usr/bin/env python3
"""Apply narrowly scoped, audited cleanup to a completed ownership export."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from benchmark.correction_workflow import decode_binary_mask, encode_binary_mask
from benchmark.materialize_ownership_corrections import validate_payload


READY_STATUSES = {"approved", "corrected"}

# These detached components were visually confirmed as foreground, not rear band.
# Exact per-case areas make the finalizer fail closed if the source export changes
# instead of silently applying a broad connected-component heuristic. Larger
# disconnected components are intentionally preserved because occlusion can split
# a valid rear band into several visible pieces.
EXPECTED_TINY_BACK_COMPONENTS = {
    "core-cushion-flower-halo-double-twist": (1, 1),
    "core-emerald-flower-halo-double": (1,),
    "core-emerald-flower-halo-single": (2,),
    "core-marquise-basket-double": (2,),
    "core-marquise-basket-split": (1, 1),
    "core-oval-flower-halo-double": (2,),
    "core-princess-flower-halo-double": (1,),
    "extreme-princess-flower-halo-10-ct": (1,),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corrections", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--selection", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    corrections_path = Path(args.corrections).resolve()
    report_path = Path(args.report).resolve()
    selection_path = Path(args.selection).resolve()
    output_path = Path(args.out).resolve()

    payload = json.loads(corrections_path.read_text())
    report = json.loads(report_path.read_text())
    selection = json.loads(selection_path.read_text())
    validate_payload(payload, report, report_path, selection_path)

    report_by_id = {case["id"]: case for case in report["cases"]}
    selected_ids = {case["id"] for case in selection["cases"]}
    states = payload.get("cases", {})
    if set(states) != selected_ids:
        raise ValueError("correction cases do not exactly match the frozen selection")
    not_ready = {case_id: state.get("status") for case_id, state in states.items()
                 if state.get("status") not in READY_STATUSES}
    if not_ready:
        raise ValueError(f"correction export is not complete: {not_ready}")

    operations = []
    for case_id, expected_areas in EXPECTED_TINY_BACK_COMPONENTS.items():
        state = states[case_id]
        case = report_by_id[case_id]
        full_path = report_path.parent / case["masks"]["full"]
        full_u8 = cv2.imread(str(full_path), cv2.IMREAD_GRAYSCALE)
        if full_u8 is None:
            raise ValueError(f"missing full matte for {case_id}")
        if tuple(full_u8.shape) != (int(state["height"]), int(state["width"])):
            raise ValueError(f"mask dimensions differ for {case_id}")
        back = decode_binary_mask(state["back_runs"], full_u8.shape)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(
            back.astype(np.uint8), 8)
        tiny_labels = [index for index in range(1, count)
                       if int(stats[index, cv2.CC_STAT_AREA]) < 32]
        actual_areas = tuple(sorted(int(stats[index, cv2.CC_STAT_AREA])
                                    for index in tiny_labels))
        if actual_areas != expected_areas:
            raise ValueError(
                f"{case_id} tiny component mismatch: expected {expected_areas}, "
                f"found {actual_areas}"
            )
        remove = np.isin(labels, tiny_labels)
        back[remove] = False
        state["back_runs"] = encode_binary_mask(back)
        state["status"] = "corrected"
        moved = int(remove.sum())
        audit_note = f"Final audit: moved {moved} detached foreground pixels Back→Front."
        existing = state.get("notes", "").strip()
        state["notes"] = f"{existing} {audit_note}".strip()
        operations.append({
            "case_id": case_id,
            "operation": "back_to_front",
            "pixels": moved,
            "component_areas": list(actual_areas),
        })

    payload["finalization"] = {
        "schema_version": 1,
        "finalized_at": datetime.now(timezone.utc).isoformat(),
        "source_export": str(corrections_path),
        "source_export_sha256": sha256(corrections_path),
        "operations": operations,
    }
    output_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(output_path)
    print(f"finalized {len(states)} labels; moved "
          f"{sum(item['pixels'] for item in operations)} Back→Front pixels")


if __name__ == "__main__":
    main()
