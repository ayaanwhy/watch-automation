"""Conservative holdout checks across checkpoint training dependencies."""

import json
import pickle
from pathlib import Path

import torch


REPO_ROOT = Path(__file__).resolve().parents[1]
DEPENDENCIES = ("init", "back_teacher", "matte_teacher",
                "matte_checkpoint", "back_checkpoint")


def _resolve(reference, checkpoint_path):
    path = Path(reference)
    if path.is_absolute():
        return path.resolve()
    # Training CLIs record repository-relative paths. Also support portable
    # checkpoints whose dependencies are relative to their own directory.
    candidates = (REPO_ROOT / path, checkpoint_path.parent / path)
    existing = {candidate.resolve() for candidate in candidates
                if candidate.is_file()}
    if len(existing) > 1:
        raise ValueError(f"ambiguous checkpoint reference: {reference}")
    return next(iter(existing)) if existing else candidates[0].resolve()


def holdout_validity(checkpoint, checkpoint_path, split=None):
    """Return true only when the complete recorded lineage proves no overlap.

    ``strict_holdout`` is null when evidence is missing, false for known
    overlap, and true for a verified clean lineage. Counts with incomplete
    provenance describe known overlap only.
    """
    checkpoint_path = Path(checkpoint_path).resolve()
    issues, ancestors, overlap, current_overlap = [], set(), set(), set()
    active, visited = set(), set()

    def read_split(path):
        try:
            value = json.loads(path.read_text())
            if not isinstance(value, dict):
                raise ValueError("split must be an object")
            return value
        except (OSError, ValueError) as error:
            issues.append(f"{path}: {error}")
            return {}

    def split_for(payload, path):
        args = payload.get("args") or {}
        if not isinstance(args, dict):
            raise ValueError(f"{path}: checkpoint args must be an object")
        reference = args.get("back_checkpoint")
        source = _resolve(reference, path) if reference else path
        return read_split(source.parent / "split.json")

    if split is None:
        try:
            split = split_for(checkpoint, checkpoint_path)
        except (TypeError, ValueError) as error:
            issues.append(str(error))
            split = {}
    validation = split.get("val_designs")
    if (not isinstance(validation, list) or not validation or
            not all(isinstance(value, str) for value in validation)):
        issues.append("missing or empty validation design list")
        validation = []
    validation = set(validation)

    def visit(payload, path, run_split=None):
        if path in active:
            issues.append(f"cyclic checkpoint ancestry: {path}")
            return
        if path in visited:
            return
        active.add(path)
        try:
            run_split = split_for(payload, path) if run_split is None else run_split
            training = run_split.get("train_designs")
            if (not isinstance(training, list) or not training or
                    not all(isinstance(value, str) for value in training)):
                issues.append(f"{path}: missing training design list")
            else:
                shared = validation & set(training)
                (current_overlap if path == checkpoint_path else overlap).update(shared)
            fingerprint = payload.get("data_fingerprint")
            if (not fingerprint or not run_split.get("fingerprint") or
                    fingerprint != run_split["fingerprint"]):
                issues.append(f"{path}: missing or mismatched split fingerprint")
            args = payload.get("args")
            if not isinstance(args, dict) or "init" not in args:
                issues.append(f"{path}: initialization history is missing")
            if isinstance(args, dict):
                for field in DEPENDENCIES:
                    reference = args.get(field)
                    if reference is None:
                        continue
                    if not isinstance(reference, str) or not reference:
                        issues.append(f"{path}: invalid {field} reference")
                        continue
                    try:
                        parent = _resolve(reference, path)
                        if parent in active:
                            issues.append(f"cyclic checkpoint ancestry: {parent}")
                            continue
                        if parent in visited:
                            continue
                        ancestor = torch.load(parent, map_location="cpu",
                                              weights_only=False)
                        if not isinstance(ancestor, dict):
                            raise ValueError("checkpoint must be a dictionary")
                        ancestors.add(str(parent))
                        visit(ancestor, parent)
                    except (OSError, ValueError, TypeError, RuntimeError,
                            EOFError, pickle.UnpicklingError) as error:
                        issues.append(f"{path} {field}: {error}")
        except (TypeError, ValueError) as error:
            issues.append(f"{path}: {error}")
        finally:
            active.remove(path)
            visited.add(path)

    visit(checkpoint, checkpoint_path, split)
    contaminated = bool(overlap or current_overlap)
    strict = False if contaminated else None if issues else True
    return {
        "strict_holdout": strict,
        "status": "overlap" if contaminated else "unknown" if issues else "clean",
        "provenance_complete": not issues,
        "pretraining_overlap_designs": len(overlap),
        "pretraining_overlap_design_ids": sorted(overlap),
        "current_training_overlap_design_ids": sorted(current_overlap),
        "checked_ancestor_checkpoints": sorted(ancestors),
        "issues": issues,
        "warning": (None if strict is True else
                    "Holdout independence is not established; use this report "
                    "for diagnostics, not an unbiased benchmark."),
    }
