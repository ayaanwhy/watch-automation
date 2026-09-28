"""Train a residual corrector on final production ownership masks."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

from vto.data import cached_meta, design_of, find_cached
from vto.model import boundary_band
from vto.ownership_refiner import OwnershipRefiner, apply_actions
from vto.train import (data_fingerprint, holdout_designs_from_files,
                       split_groups)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--holdout-design-file", action="append", default=[])
    parser.add_argument("--explicit-case-holdout", action="store_true",
                        help="hold out only reviewed cases marked split=holdout; "
                             "related identity cases remain validation drift gates")
    parser.add_argument("--train-all-corrections", action="store_true",
                        help="final fit: include reviewed holdouts after the "
                             "recipe has passed its untouched-case gate")
    parser.add_argument("--correction-weight", type=float, default=12.0)
    parser.add_argument("--edit-weight", type=float, default=40.0)
    parser.add_argument("--edge-weight", type=float, default=2.0)
    parser.add_argument("--edge-radius", type=int, default=2)
    parser.add_argument("--identity-weight", type=float, default=0.05)
    parser.add_argument("--no-edit-logit", type=float, default=-6.0)
    parser.add_argument("--device",
                        default="cuda" if torch.cuda.is_available() else "cpu")
    return parser.parse_args()


class OwnershipRefinerPairs(Dataset):
    def __init__(self, items, size=512, train=True, seed=0):
        self.items = items
        self.size = int(size)
        self.train = bool(train)
        self.seed = int(seed)

    def __len__(self):
        return len(self.items)

    @staticmethod
    def _read(path, flags):
        image = cv2.imread(path, flags)
        if image is None:
            raise ValueError(f"could not read {path}")
        return image

    def __getitem__(self, index):
        item = self.items[index]
        directory = os.path.dirname(item[0])
        rgba = self._read(item[0], cv2.IMREAD_UNCHANGED)
        target = self._read(item[1], cv2.IMREAD_GRAYSCALE)
        base = self._read(os.path.join(directory, "base_back.png"),
                          cv2.IMREAD_GRAYSCALE)
        edit = self._read(os.path.join(directory, "back_edit.png"),
                          cv2.IMREAD_GRAYSCALE)
        rgb = rgba[..., :3].astype(np.float32)
        full = rgba[..., 3].astype(np.float32) / 255.0
        base = (base > 127).astype(np.float32)
        target = (target > 127).astype(np.float32)
        edit = (edit > 127).astype(np.float32)

        rng_seed = ((torch.initial_seed() if self.train else self.seed) +
                    0x9E3779B1 * (index + 1)) % (2 ** 63 - 1)
        rng = np.random.default_rng(rng_seed)
        if self.train:
            height, width = full.shape
            matrix = cv2.getRotationMatrix2D(
                (width / 2, height / 2), rng.uniform(-8, 8),
                rng.uniform(0.90, 1.10))
            matrix[0, 2] += rng.uniform(-0.02, 0.02) * width
            matrix[1, 2] += rng.uniform(-0.02, 0.02) * height
            rgb = cv2.warpAffine(rgb, matrix, (width, height),
                                 flags=cv2.INTER_LINEAR,
                                 borderValue=(247, 247, 247))
            full = cv2.warpAffine(full, matrix, (width, height),
                                  flags=cv2.INTER_NEAREST)
            base = cv2.warpAffine(base, matrix, (width, height),
                                  flags=cv2.INTER_NEAREST)
            target = cv2.warpAffine(target, matrix, (width, height),
                                    flags=cv2.INTER_NEAREST)
            edit = cv2.warpAffine(edit, matrix, (width, height),
                                  flags=cv2.INTER_NEAREST)
            if rng.random() < 0.5:
                rgb = rgb[:, ::-1]
                full, base = full[:, ::-1], base[:, ::-1]
                target, edit = target[:, ::-1], edit[:, ::-1]

        size = self.size
        rgb = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_AREA)
        full = cv2.resize(full, (size, size), interpolation=cv2.INTER_NEAREST)
        base = cv2.resize(base, (size, size), interpolation=cv2.INTER_NEAREST)
        target = cv2.resize(target, (size, size), interpolation=cv2.INTER_NEAREST)
        edit = cv2.resize(edit, (size, size), interpolation=cv2.INTER_NEAREST)
        base *= full > 0.5
        target *= full > 0.5
        edit = np.maximum(edit, base != target).astype(np.float32)
        if self.train:
            rgb = rgb * rng.uniform(0.93, 1.07) + rng.uniform(-5, 5)
        rgb = np.clip(rgb, 0, 255) / 255.0

        def tensor(array):
            return torch.from_numpy(np.ascontiguousarray(array).astype(np.float32))

        is_correction = float(
            cached_meta(item).get("target_source") == "reviewed_correction")
        return (tensor(rgb.transpose(2, 0, 1)), tensor(full[None]),
                tensor(base[None]), tensor(target[None]), tensor(edit[None]),
                torch.tensor(is_correction, dtype=torch.float32))


def ownership_loss(logits, full, base, target, edit, *, edit_weight,
                   edge_weight, edge_radius, identity_weight):
    active = (full > 0.5).to(logits.dtype)
    remove = (base > 0.5).to(logits.dtype) * (target <= 0.5).to(logits.dtype)
    add = (base <= 0.5).to(logits.dtype) * (target > 0.5).to(logits.dtype)
    actions = torch.cat((remove, add), dim=1) * active
    possible = torch.cat((base, 1.0 - base), dim=1) * active
    weights = possible * (1.0 + float(edit_weight) * actions)
    if edge_weight > 0:
        weights = weights * (1.0 + float(edge_weight) *
                             boundary_band(actions, edge_radius))
    pixels = F.binary_cross_entropy_with_logits(logits, actions,
                                                 reduction="none")
    bce = (pixels * weights).sum() / weights.sum().clamp(min=1.0)
    unchanged = possible * (1.0 - actions)
    identity = ((logits.sigmoid() * unchanged).sum() /
                unchanged.sum().clamp(min=1.0))
    return bce + float(identity_weight) * identity


def iou_per_sample(pred, target):
    intersection = (pred & target).sum((1, 2, 3)).float()
    union = (pred | target).sum((1, 2, 3)).float()
    return intersection / union.clamp(min=1)


def summarize(rows, correction):
    selected = [row for row in rows if row["correction"] == correction]
    if not selected:
        return {"cases": 0}
    deltas = [row["candidate_iou"] - row["baseline_iou"] for row in selected]
    return {
        "cases": len(selected),
        "baseline_iou": float(np.mean([row["baseline_iou"] for row in selected])),
        "candidate_iou": float(np.mean([row["candidate_iou"] for row in selected])),
        "mean_delta": float(np.mean(deltas)),
        "improved": sum(delta > 0 for delta in deltas),
        "tied": sum(delta == 0 for delta in deltas),
        "regressed": sum(delta < 0 for delta in deltas),
    }


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    torch.manual_seed(args.seed)
    items = find_cached(args.data)
    holdouts = holdout_designs_from_files(args.holdout_design_file)
    train_items, val_items, groups, _, val_keys = split_groups(
        items, 0.0, args.seed, holdouts, explicit_holdout_only=True)
    if args.explicit_case_holdout:
        train_items, val_items = [], []
        for item in items:
            metadata = cached_meta(item)
            corrected_holdout = (
                metadata.get("target_source") == "reviewed_correction" and
                metadata.get("split") == "holdout" and
                not args.train_all_corrections)
            related_identity = (
                metadata.get("target_source") == "production_identity" and
                design_of(item) in holdouts)
            (val_items if corrected_holdout or related_identity else
             train_items).append(item)
        val_keys = sorted(set(design_of(item) for item in val_items))
    print(f"[i] {len(items)} items / {len(groups)} groups -> "
          f"{len(train_items)} train / {len(val_items)} family holdout")
    print("[i] reviewed corrections -> "
          f"{sum(cached_meta(item).get('target_source') == 'reviewed_correction' for item in train_items)} train / "
          f"{sum(cached_meta(item).get('target_source') == 'reviewed_correction' for item in val_items)} holdout")
    manifest = {
        "args": vars(args),
        "fingerprint": data_fingerprint(items),
        "train_designs": sorted(set(design_of(item) for item in train_items)),
        "val_designs": sorted(val_keys),
    }
    with open(os.path.join(args.out, "split.json"), "w") as handle:
        json.dump(manifest, handle, indent=2)

    weights = [args.correction_weight if
               cached_meta(item).get("target_source") == "reviewed_correction"
               else 1.0 for item in train_items]
    sampler = WeightedRandomSampler(
        weights, len(train_items), replacement=True,
        generator=torch.Generator().manual_seed(args.seed))
    train_loader = DataLoader(
        OwnershipRefinerPairs(train_items, args.size, True, args.seed),
        batch_size=args.batch, sampler=sampler, num_workers=args.workers,
        pin_memory=True)
    val_loader = DataLoader(
        OwnershipRefinerPairs(val_items, args.size, False, args.seed),
        batch_size=args.batch, shuffle=False, num_workers=args.workers,
        pin_memory=True)

    model = OwnershipRefiner(args.no_edit_logit).to(args.device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr,
                                  weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr,
        total_steps=max(args.epochs * len(train_loader), 1), pct_start=0.25)
    scaler = torch.amp.GradScaler(enabled=args.device.startswith("cuda"))
    best_score = -float("inf")
    val_names = [Path(item[0]).parent.name for item in val_items]
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        seen = 0
        started = time.time()
        for rgb, full, base, target, edit, _ in train_loader:
            rgb, full = rgb.to(args.device), full.to(args.device)
            base, target = base.to(args.device), target.to(args.device)
            edit = edit.to(args.device)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=args.device.startswith("cuda")):
                logits = model(rgb, full, base)
                loss = ownership_loss(
                    logits, full, base, target, edit,
                    edit_weight=args.edit_weight, edge_weight=args.edge_weight,
                    edge_radius=args.edge_radius,
                    identity_weight=args.identity_weight)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            total += float(loss) * len(rgb)
            seen += len(rgb)

        model.eval()
        rows = []
        cursor = 0
        with torch.no_grad():
            for rgb, full, base, target, _, correction in val_loader:
                logits = model(rgb.to(args.device), full.to(args.device),
                               base.to(args.device))
                candidate = apply_actions(base, logits.cpu(), threshold=0.5)
                expected = target > 0.5
                baseline = base > 0.5
                candidate_iou = iou_per_sample(candidate, expected)
                baseline_iou = iou_per_sample(baseline, expected)
                for index in range(len(rgb)):
                    rows.append({
                        "name": val_names[cursor + index],
                        "correction": bool(correction[index]),
                        "baseline_iou": float(baseline_iou[index]),
                        "candidate_iou": float(candidate_iou[index]),
                    })
                cursor += len(rgb)
        correction_summary = summarize(rows, True)
        identity_summary = summarize(rows, False)
        # Corrected family holdouts drive improvement; identity cases penalize
        # broad drift.  Regression count is recorded and checked before any
        # promotion rather than hidden inside one average.
        score = (correction_summary.get("candidate_iou", 0.0) +
                 0.25 * identity_summary.get("candidate_iou", 0.0))
        checkpoint = {
            "architecture": OwnershipRefiner.architecture,
            "refiner": model.state_dict(),
            "size": args.size,
            "no_edit_logit": args.no_edit_logit,
            "epoch": epoch,
            "selection_score": score,
            "correction_validation": correction_summary,
            "identity_validation": identity_summary,
            "validation_cases": rows,
            "data_fingerprint": manifest["fingerprint"],
            "args": vars(args),
        }
        torch.save(checkpoint, os.path.join(args.out, f"epoch_{epoch:03d}.pt"))
        torch.save(checkpoint, os.path.join(args.out, "last.pt"))
        if score > best_score:
            best_score = score
            torch.save(checkpoint, os.path.join(args.out, "best.pt"))
        print(f"ep {epoch:3d} loss {total/max(seen,1):.4f} "
              f"corrected {correction_summary.get('candidate_iou', 0):.6f} "
              f"delta {correction_summary.get('mean_delta', 0):+.6f} "
              f"I/R {correction_summary.get('improved', 0)}/"
              f"{correction_summary.get('regressed', 0)} identity "
              f"{identity_summary.get('candidate_iou', 0):.6f} "
              f"({time.time()-started:.0f}s)")
    print(f"[ok] best score {best_score:.6f} -> {args.out}")


if __name__ == "__main__":
    main()
