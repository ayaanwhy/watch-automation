"""Train the isolated multi-task product validator."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from .dataset import (ValidatorDataset, class_weights, manifest_fingerprint,
                      split_groups)
from .engine import (collect_predictions, metric_summary, move_targets,
                     seed_everything, selection_score)
from .isolation import HERE, REPO_ROOT, require_isolation, safe_output
from .losses import multitask_loss
from .manifest import audit_manifest, load_manifest
from .model import ARCHITECTURE, ProductValidator
from .taxonomy import (ASSET_CLASSES, QUALITY_FLAGS, ROTATION_CLASSES,
                       VIEW_CLASSES)


def _labeled(case: dict) -> bool:
    labels = case["labels"]
    return any(labels.get(key) is not None
               for key in ("asset", "view", "rotation", "suitable",
                           "quality"))


def _positive_weight(cases: list[dict], field: str):
    known = [case["labels"].get(field) for case in cases
             if case["labels"].get(field) is not None]
    positives = sum(bool(value) for value in known)
    negatives = len(known) - positives
    if not positives or not negatives:
        return None
    return torch.tensor([negatives / positives], dtype=torch.float32)


def _quality_positive_weight(cases: list[dict]):
    known = [case["labels"]["quality"] for case in cases
             if case["labels"].get("quality") is not None]
    if not known:
        return None
    weights = []
    for flag in QUALITY_FLAGS:
        positives = sum(flag in flags for flags in known)
        negatives = len(known) - positives
        weights.append(1.0 if not positives or not negatives
                       else negatives / positives)
    return torch.tensor(weights, dtype=torch.float32)


def _state_dict_cpu(model):
    return {name: value.detach().cpu() for name, value in model.state_dict().items()}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--image-size", type=int, default=224)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--val-fraction", type=float, default=0.20)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--freeze-backbone-epochs", type=int, default=2)
    parser.add_argument("--no-pretrained", action="store_true")
    parser.add_argument(
        "--allow-incomplete-data", action="store_true",
        help="research only: bypass the production data-readiness gate")
    return parser.parse_args()


def main():
    args = parse_args()
    require_isolation(REPO_ROOT)
    manifest_path = Path(args.manifest).resolve()
    manifest = load_manifest(manifest_path)
    audit = audit_manifest(manifest_path)
    if not audit["ready"] and not args.allow_incomplete_data:
        print(json.dumps(audit, indent=2))
        raise SystemExit(
            "data-readiness gate failed; collect/review missing classes before training")

    cases = [case for case in manifest["cases"] if _labeled(case)]
    if len(cases) < 2:
        raise SystemExit("at least two labeled product groups are required")
    train_cases, val_cases, val_groups = split_groups(
        cases, val_fraction=args.val_fraction, seed=args.seed)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = Path(args.output) if args.output else HERE / "runs" / timestamp
    output = safe_output(output, HERE / "runs")
    output.mkdir(parents=True, exist_ok=False)

    if args.device == "auto":
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise SystemExit("CUDA was requested but is unavailable")
    seed_everything(args.seed)

    train_data = ValidatorDataset(
        manifest_path, train_cases, args.image_size, train=True)
    val_data = ValidatorDataset(
        manifest_path, val_cases, args.image_size, train=False)
    loader_args = dict(batch_size=args.batch_size, num_workers=args.workers,
                       pin_memory=device.type == "cuda")
    train_loader = DataLoader(train_data, shuffle=True, **loader_args)
    val_loader = DataLoader(val_data, shuffle=False, **loader_args)

    model = ProductValidator(pretrained=not args.no_pretrained).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate,
        weight_decay=args.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(args.epochs, 1))
    amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=amp)

    asset_weight = class_weights(train_cases, "asset", ASSET_CLASSES)
    view_weight = class_weights(train_cases, "view", VIEW_CLASSES)
    rotation_weight = class_weights(
        train_cases, "rotation", ROTATION_CLASSES)
    suitable_weight = _positive_weight(train_cases, "suitable")
    quality_weight = _quality_positive_weight(train_cases)
    weights = [asset_weight, view_weight, rotation_weight, suitable_weight,
               quality_weight]
    (asset_weight, view_weight, rotation_weight, suitable_weight,
     quality_weight) = [
        value.to(device) if value is not None else None for value in weights]

    history = []
    best_score = float("-inf")
    for epoch in range(args.epochs):
        train_backbone = epoch >= args.freeze_backbone_epochs
        for parameter in model.features.parameters():
            parameter.requires_grad_(train_backbone)
        model.train()
        totals = {name: 0.0 for name in
                  ("total", "asset", "view", "rotation", "suitable",
                   "quality")}
        seen = 0
        for batch in train_loader:
            images = batch["image"].to(device, non_blocking=True)
            targets = move_targets(batch, device)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=amp):
                outputs = model(images)
                loss, parts = multitask_loss(
                    outputs, targets, asset_weight=asset_weight,
                    view_weight=view_weight,
                    rotation_weight=rotation_weight,
                    quality_pos_weight=quality_weight)
                if suitable_weight is not None:
                    # Suitable is a single binary head, so apply its imbalance
                    # weight separately while preserving the masked behavior.
                    from .losses import masked_binary_cross_entropy
                    parts["suitable"] = masked_binary_cross_entropy(
                        outputs[3], targets["suitable"], suitable_weight)
                    loss = (parts["asset"] + parts["view"] +
                            0.75 * parts["rotation"] + parts["suitable"] +
                            0.5 * parts["quality"])
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            count = images.shape[0]
            seen += count
            totals["total"] += float(loss.detach()) * count
            for name, value in parts.items():
                totals[name] += float(value.detach()) * count
        scheduler.step()

        predictions = collect_predictions(model, val_loader, device)
        metrics = metric_summary(predictions)
        score = selection_score(metrics)
        row = {
            "epoch": epoch + 1,
            "learning_rate": optimizer.param_groups[0]["lr"],
            "train_loss": {name: value / max(seen, 1)
                           for name, value in totals.items()},
            "selection_score": score,
            "validation": metrics,
        }
        history.append(row)
        print(json.dumps({"epoch": epoch + 1, "score": score,
                          "loss": row["train_loss"]["total"]}))

        checkpoint = {
            "architecture": ARCHITECTURE,
            "dropout": 0.20,
            "model": _state_dict_cpu(model),
            "manifest_fingerprint": manifest_fingerprint(manifest),
            "manifest_path": str(manifest_path),
            "val_groups": sorted(val_groups),
            "image_size": args.image_size,
            "epoch": epoch + 1,
            "selection_score": score,
            "metrics": metrics,
            "classes": {"asset": ASSET_CLASSES, "view": VIEW_CLASSES,
                        "rotation": ROTATION_CLASSES,
                        "quality": QUALITY_FLAGS},
            "training_args": vars(args),
        }
        torch.save(checkpoint, output / "last.pt")
        if score > best_score:
            best_score = score
            torch.save(checkpoint, output / "best.pt")
    (output / "history.json").write_text(json.dumps(history, indent=2) + "\n")
    (output / "data_audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    print(json.dumps({"output": str(output), "best_score": best_score,
                      "device": str(device), "train": len(train_cases),
                      "validation": len(val_cases)}, indent=2))


if __name__ == "__main__":
    main()
