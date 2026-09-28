"""Shared selection and mask-payload primitives for ownership correction.

The configurator benchmark has no semantic front/back truth.  This module
builds a compact, deterministic annotation set and defines the lossless binary
mask format used by the browser editor and the training-data materializer.
"""

from __future__ import annotations

import hashlib
from collections import Counter

import numpy as np


SCHEMA = "jewelsense.ownership-corrections/v2"

MANUAL_REVIEW_STATUSES = ("approved", "inspect", "rejected")

FEATURE_FIELDS = (
    "Center stone shape",
    "Ring head type",
    "Mounting type",
    "Side setting",
    "Side stones type",
    "Side stones length",
    "Center stone size",
)

# Cases repeatedly implicated during visual review.  They seed the selection;
# the remaining budget is filled by weighted feature and feature-pair coverage.
KNOWN_DEFECT_CASES = (
    "side-bead-alt-ruby-1-2",
    "side-channel-alt-sapphire-1-2",
    "core-cushion-crown-contemporary",
    "core-cushion-peg-head-contemporary",
    "core-marquise-flower-halo-contemporary",
    "core-pear-single-halo-contemporary",
    "core-princess-flower-halo-double",
    "extreme-marquise-basket-10-ct",
)


def encode_binary_mask(mask: np.ndarray) -> list[list[int]]:
    """Encode foreground runs as ``[start, length]`` in row-major order."""
    flat = np.asarray(mask, dtype=bool).reshape(-1)
    padded = np.concatenate(([False], flat, [False])).astype(np.int8)
    edges = np.flatnonzero(np.diff(padded))
    return [[int(start), int(stop - start)]
            for start, stop in zip(edges[::2], edges[1::2])]


def decode_binary_mask(runs, shape: tuple[int, int]) -> np.ndarray:
    """Decode and strictly validate row-major foreground runs."""
    height, width = map(int, shape)
    if height <= 0 or width <= 0:
        raise ValueError("mask dimensions must be positive")
    size = height * width
    flat = np.zeros(size, dtype=bool)
    previous_stop = 0
    for index, run in enumerate(runs):
        if not isinstance(run, (list, tuple)) or len(run) != 2:
            raise ValueError(f"invalid run at index {index}")
        start, length = run
        if isinstance(start, bool) or isinstance(length, bool):
            raise ValueError(f"invalid boolean run at index {index}")
        start, length = int(start), int(length)
        stop = start + length
        if start < previous_stop or length <= 0 or stop > size:
            raise ValueError(f"out-of-order or out-of-bounds run at index {index}")
        flat[start:stop] = True
        previous_stop = stop
    return flat.reshape(height, width)


def _suite(case_id: str) -> str:
    return case_id.split("-", 1)[0]


def _case_tokens(case: dict) -> set[str]:
    selected = case.get("selected", {})
    singles = []
    for field in FEATURE_FIELDS:
        value = str(selected.get(field, "<missing>"))
        singles.append((field, value))
    tokens = {f"single:{field}={value}" for field, value in singles}
    # Geometry-bearing pairs make the sample more useful than simply checking
    # each control value once.
    pair_fields = (
        ("Center stone shape", "Ring head type"),
        ("Center stone shape", "Mounting type"),
        ("Ring head type", "Mounting type"),
        ("Side setting", "Side stones type"),
    )
    for left, right in pair_fields:
        tokens.add(
            f"pair:{left}={selected.get(left, '<missing>')}|"
            f"{right}={selected.get(right, '<missing>')}"
        )
    tokens.add(f"suite:{_suite(case['id'])}")
    return tokens


def _risk(case: dict) -> float:
    metrics = case.get("metrics", {})
    back_fraction = float(metrics.get("back_fraction", 0.0))
    components = float(metrics.get("back_components", 1.0))
    # A deliberately small tie-breaker.  Selection is driven by geometry
    # coverage, not by a structural metric pretending to be semantic truth.
    unusual_fraction = min(abs(back_fraction - 0.28), 0.28) / 0.28
    return unusual_fraction + min(abs(components - 1.0), 3.0) / 3.0


def _coverage_score(case: dict, uncovered: set[str], frequencies: Counter) -> float:
    score = 0.0
    for token in _case_tokens(case) & uncovered:
        if token.startswith("single:"):
            base = 10.0
        elif token.startswith("pair:"):
            base = 3.0
        else:
            base = 8.0
        score += base / max(frequencies[token], 1) ** 0.5
    return score + 0.01 * _risk(case)


def select_representative_cases(report: dict, budget: int = 72,
                                mandatory_ids=KNOWN_DEFECT_CASES) -> list[dict]:
    """Return a deterministic, geometry-balanced subset of successful rings."""
    candidates = [case for case in report.get("cases", [])
                  if case.get("status") == "ok" and case.get("masks")
                  and case.get("asset_type", report.get("asset_type", "ring")) == "ring"]
    if budget <= 0:
        raise ValueError("budget must be positive")
    if budget > len(candidates):
        raise ValueError(f"budget {budget} exceeds {len(candidates)} available rings")

    by_id = {case["id"]: case for case in candidates}
    selected = []
    selected_ids = set()
    for case_id in mandatory_ids:
        if case_id in by_id and case_id not in selected_ids:
            selected.append(by_id[case_id])
            selected_ids.add(case_id)
    if len(selected) > budget:
        raise ValueError("mandatory cases exceed selection budget")

    token_sets = {case["id"]: _case_tokens(case) for case in candidates}
    frequencies = Counter(token for tokens in token_sets.values() for token in tokens)
    uncovered = set(frequencies)
    for case in selected:
        uncovered -= token_sets[case["id"]]

    while len(selected) < budget:
        remaining = (case for case in candidates if case["id"] not in selected_ids)
        best = max(remaining, key=lambda case: (
            _coverage_score(case, uncovered, frequencies),
            _risk(case),
            # Reverse hash sorting without relying on report order.
            hashlib.sha256(case["id"].encode()).hexdigest(),
        ))
        selected.append(best)
        selected_ids.add(best["id"])
        uncovered -= token_sets[best["id"]]
    return selected


def select_manual_decision_cases(report: dict, decision_export: dict,
                                 statuses=("rejected", "inspect")) -> list[dict]:
    """Resolve an exact correction pool from a manual benchmark review.

    Status order is significant so definite rejections can be corrected before
    uncertain inspection cases. Snapshot and runtime identity are verified
    before any correction assets are built.
    """
    snapshot_id = report.get("snapshot_id")
    runtime_signature = report.get("runtime", {}).get("signature")
    if decision_export.get("snapshot") != snapshot_id:
        raise ValueError("manual decisions belong to a different snapshot")
    if decision_export.get("runtime") != runtime_signature:
        raise ValueError("manual decisions belong to a different runtime")

    decisions = decision_export.get("decisions")
    if not isinstance(decisions, dict):
        raise ValueError("manual decisions must contain a decisions object")
    requested = tuple(statuses)
    if not requested or len(set(requested)) != len(requested):
        raise ValueError("manual decision statuses must be unique and non-empty")
    unknown_requested = set(requested) - set(MANUAL_REVIEW_STATUSES)
    if unknown_requested:
        raise ValueError(
            f"unknown requested manual status: {sorted(unknown_requested)[0]}"
        )

    available = {case["id"]: case for case in report.get("cases", [])}
    grouped = {status: [] for status in requested}
    for case_id, decision in decisions.items():
        if not isinstance(decision, dict):
            raise ValueError(f"invalid manual decision for {case_id}")
        status = decision.get("status")
        if status not in MANUAL_REVIEW_STATUSES:
            raise ValueError(f"unknown manual status for {case_id}: {status}")
        if case_id not in available:
            raise ValueError(f"manual decision case is absent from report: {case_id}")
        if status in grouped:
            case = available[case_id]
            if (case.get("status") != "ok" or not case.get("masks")
                    or case.get("asset_type", report.get("asset_type", "ring")) != "ring"):
                raise ValueError(f"manual correction case is not an available ring: {case_id}")
            grouped[status].append({**case, "manual_review_status": status})

    selected = [case for status in requested for case in grouped[status]]
    if not selected:
        raise ValueError("manual decisions contain no cases with requested statuses")
    return selected


def assign_geometry_holdout(cases: list[dict], holdout_size: int = 16) -> dict[str, str]:
    """Assign source-identical cases together while balancing holdout geometry."""
    if not 0 <= holdout_size < len(cases):
        raise ValueError("holdout_size must be smaller than the selected set")
    if holdout_size == 0:
        return {case["id"]: "train" for case in cases}

    groups: dict[str, list[dict]] = {}
    for case in cases:
        key = str(case.get("source_sha256") or case["id"])
        groups.setdefault(key, []).append(case)

    all_tokens = {case["id"]: _case_tokens(case) for case in cases}
    uncovered = set(token for tokens in all_tokens.values() for token in tokens)
    chosen_groups = set()
    chosen_count = 0
    while chosen_count < holdout_size:
        viable = [(key, members) for key, members in groups.items()
                  if key not in chosen_groups and chosen_count + len(members) <= holdout_size]
        if not viable:
            break
        key, members = max(viable, key=lambda item: (
            sum(1.0 for member in item[1] for token in all_tokens[member["id"]]
                if token in uncovered) / len(item[1]),
            hashlib.sha256(item[0].encode()).hexdigest(),
        ))
        chosen_groups.add(key)
        chosen_count += len(members)
        for member in members:
            uncovered -= all_tokens[member["id"]]

    if chosen_count != holdout_size:
        raise ValueError(
            f"could not assign exactly {holdout_size} holdout cases without source leakage; "
            f"assigned {chosen_count}"
        )
    return {case["id"]: ("holdout" if str(case.get("source_sha256") or case["id"])
                         in chosen_groups else "train") for case in cases}


def coverage_summary(cases: list[dict]) -> dict:
    """Human-readable coverage included in the selection manifest."""
    values = {}
    for field in FEATURE_FIELDS:
        values[field] = sorted({str(case.get("selected", {}).get(field, "<missing>"))
                                for case in cases})
    return {
        "cases": len(cases),
        "suites": sorted({_suite(case["id"]) for case in cases}),
        "values": values,
        "geometry_triples": len({(
            case.get("selected", {}).get("Center stone shape"),
            case.get("selected", {}).get("Ring head type"),
            case.get("selected", {}).get("Mounting type"),
        ) for case in cases}),
    }
