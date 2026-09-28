import json

import pytest
import torch

from vto.provenance import holdout_validity


def make_run(root, name, train=("train",), init=None, **dependencies):
    path = root / name / "best.pt"
    path.parent.mkdir(parents=True)
    payload = {"args": {"init": str(init) if init else None, **dependencies},
               "data_fingerprint": name}
    split = {"train_designs": list(train), "val_designs": ["test"],
             "fingerprint": name}
    path.with_name("split.json").write_text(json.dumps(split))
    torch.save(payload, path)
    return path, payload, split


def test_complete_clean_ancestry(tmp_path):
    base, _, _ = make_run(tmp_path, "base")
    parent, _, _ = make_run(tmp_path, "parent", init=base)
    path, payload, split = make_run(tmp_path, "child", init=parent)
    result = holdout_validity(payload, path, split)
    assert result["strict_holdout"] is True
    assert result["status"] == "clean"
    assert len(result["checked_ancestor_checkpoints"]) == 2


def test_grandparent_overlap_is_detected(tmp_path):
    base, _, _ = make_run(tmp_path, "base", train=("test",))
    parent, _, _ = make_run(tmp_path, "parent", init=base)
    path, payload, split = make_run(tmp_path, "child", init=parent)
    result = holdout_validity(payload, path, split)
    assert result["strict_holdout"] is False
    assert result["pretraining_overlap_design_ids"] == ["test"]
    assert result["provenance_complete"] is True


@pytest.mark.parametrize("missing", ["checkpoint", "split", "args", "init", "fingerprint",
                                     "corrupt_checkpoint", "corrupt_split"])
def test_missing_ancestry_is_unknown(tmp_path, missing):
    base, payload, _ = make_run(tmp_path, "base")
    if missing == "checkpoint":
        base.unlink()
    elif missing == "split":
        base.with_name("split.json").unlink()
    elif missing == "corrupt_checkpoint":
        base.write_bytes(b"not a checkpoint")
    elif missing == "corrupt_split":
        base.with_name("split.json").write_text("not json")
    else:
        if missing == "args":
            del payload["args"]
        elif missing == "init":
            del payload["args"]["init"]
        else:
            del payload["data_fingerprint"]
        torch.save(payload, base)
    path, payload, split = make_run(tmp_path, "child", init=base)
    result = holdout_validity(payload, path, split)
    assert result["strict_holdout"] is None
    assert result["status"] == "unknown"
    assert result["issues"]


def test_cycle_is_unknown(tmp_path):
    path, payload, split = make_run(tmp_path, "cycle")
    payload["args"]["init"] = str(path)
    result = holdout_validity(payload, path, split)
    assert result["strict_holdout"] is None
    assert any("cyclic" in issue for issue in result["issues"])


def test_known_overlap_remains_false_with_incomplete_history(tmp_path):
    parent, _, _ = make_run(tmp_path, "parent", train=("test",),
                            init=tmp_path / "missing.pt")
    path, payload, split = make_run(tmp_path, "child", init=parent)
    result = holdout_validity(payload, path, split)
    assert result["strict_holdout"] is False
    assert result["provenance_complete"] is False


@pytest.mark.parametrize("field", ["matte_teacher", "back_teacher", "matte_checkpoint"])
def test_other_training_dependencies_are_checked(tmp_path, field):
    source, _, _ = make_run(tmp_path, "source", train=("test",))
    path, payload, split = make_run(tmp_path, "child", **{field: str(source)})
    result = holdout_validity(payload, path, split)
    assert result["strict_holdout"] is False
    assert result["pretraining_overlap_designs"] == 1


def test_current_training_overlap_is_not_a_holdout(tmp_path):
    path, payload, split = make_run(tmp_path, "current", train=("test",))
    result = holdout_validity(payload, path, split)
    assert result["strict_holdout"] is False
    assert result["current_training_overlap_design_ids"] == ["test"]


def test_mismatched_fingerprint_is_unknown(tmp_path):
    path, payload, split = make_run(tmp_path, "current")
    split["fingerprint"] = "different-dataset"
    assert holdout_validity(payload, path, split)["strict_holdout"] is None


def test_relative_dependency_and_implicit_split(tmp_path):
    make_run(tmp_path, "base")
    path, payload, _ = make_run(tmp_path, "child", init="../base/best.pt")
    assert holdout_validity(payload, path)["strict_holdout"] is True


def test_fusion_uses_back_split_and_checks_both_sources(tmp_path):
    matte, _, _ = make_run(tmp_path, "matte", train=("test",))
    back, _, _ = make_run(tmp_path, "back")
    payload = {"args": {"init": None, "matte_checkpoint": str(matte),
                        "back_checkpoint": str(back)}, "data_fingerprint": "back"}
    path = tmp_path / "fused" / "best.pt"
    result = holdout_validity(payload, path)
    assert result["strict_holdout"] is False
    assert result["pretraining_overlap_design_ids"] == ["test"]
    assert result["provenance_complete"] is True


def test_empty_validation_is_unknown(tmp_path):
    path, payload, split = make_run(tmp_path, "current")
    split["val_designs"] = []
    assert holdout_validity(payload, path, split)["strict_holdout"] is None
