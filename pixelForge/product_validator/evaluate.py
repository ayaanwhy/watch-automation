"""Evaluate a validator checkpoint on its leakage-safe holdout groups."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from .dataset import ValidatorDataset, manifest_fingerprint
from .engine import collect_predictions, metric_summary
from .isolation import HERE, REPO_ROOT, require_isolation, safe_output
from .manifest import load_manifest
from .model import model_from_checkpoint


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--split", choices=("validation", "all"),
                        default="validation")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--output")
    parser.add_argument("--allow-manifest-change", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    require_isolation(REPO_ROOT)
    manifest_path = Path(args.manifest).resolve()
    manifest = load_manifest(manifest_path)
    checkpoint = torch.load(
        args.checkpoint, map_location="cpu", weights_only=False)
    actual = manifest_fingerprint(manifest)
    expected = checkpoint.get("manifest_fingerprint")
    if actual != expected and not args.allow_manifest_change:
        raise SystemExit("manifest differs from the checkpoint training manifest")
    cases = manifest["cases"]
    if args.split == "validation":
        groups = set(checkpoint.get("val_groups", ()))
        cases = [case for case in cases if case["group_id"] in groups]
    if not cases:
        raise SystemExit("selected evaluation split is empty")

    if args.device == "auto":
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = torch.device(args.device)
    model = model_from_checkpoint(checkpoint).to(device)
    dataset = ValidatorDataset(
        manifest_path, cases, checkpoint.get("image_size", 224), train=False)
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=False,
                        num_workers=args.workers,
                        pin_memory=device.type == "cuda")
    report = {
        "checkpoint": str(Path(args.checkpoint).resolve()),
        "manifest": str(manifest_path),
        "split": args.split,
        "case_count": len(cases),
        "metrics": metric_summary(collect_predictions(model, loader, device)),
    }
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        output = safe_output(Path(args.output), HERE / "runs")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
