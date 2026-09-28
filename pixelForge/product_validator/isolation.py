"""Guardrails keeping validator work away from production model artifacts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .manifest import sha256_file


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
BASELINE = HERE / "production_model_baseline.json"


def verify_production_models(repo_root: Path = REPO_ROOT) -> dict:
    expected = json.loads(BASELINE.read_text())["protected_files"]
    files = {}
    ok = True
    for relative, digest in expected.items():
        path = repo_root / relative
        actual = sha256_file(path) if path.is_file() else None
        match = actual == digest
        files[relative] = {
            "expected": digest,
            "actual": actual,
            "unchanged": match,
        }
        ok = ok and match
    return {"unchanged": ok, "files": files}


def require_isolation(repo_root: Path = REPO_ROOT) -> None:
    report = verify_production_models(repo_root)
    if not report["unchanged"]:
        raise RuntimeError(
            "production model checksum changed; validator operation stopped")


def safe_output(path: Path, allowed_root: Path) -> Path:
    resolved = path.resolve()
    root = allowed_root.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"output must stay under {root}")
    return resolved


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(REPO_ROOT))
    args = parser.parse_args()
    report = verify_production_models(Path(args.repo))
    print(json.dumps(report, indent=2))
    if not report["unchanged"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
