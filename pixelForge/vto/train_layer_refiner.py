"""Train a sparse residual model on complete manual layer corrections."""

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
from vto.layer_refiner import LayerRefiner, apply_layer_actions, transition_targets
from vto.train import data_fingerprint, holdout_designs_from_files, split_groups


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--holdout-design-file", action="append", default=[])
    parser.add_argument("--explicit-case-holdout", action="store_true")
    parser.add_argument("--train-all-corrections", action="store_true")
    parser.add_argument("--final-fit-all", action="store_true",
                        help="after holdout recipe selection, fit all reviewed "
                             "corrections and identities; reuse all items only "
                             "as a labeled training-monitor set")
    parser.add_argument("--init", help="initialize from a layer-refiner checkpoint")
    parser.add_argument("--hard-negative-evaluation",
                        help="threshold-sweep JSON supplying accepted false positives")
    parser.add_argument("--hard-negative-threshold", type=float, default=0.95)
    parser.add_argument("--hard-negative-class-threshold",
                        help="comma-separated background,front,back setting")
    parser.add_argument("--hard-negative-min-component", type=int, default=0)
    parser.add_argument("--hard-negative-weight", type=float, default=12.0)
    parser.add_argument("--hard-positive-evaluation",
                        help="threshold-sweep JSON whose tied/regressed "
                             "corrected cases should receive extra replay")
    parser.add_argument("--hard-positive-weight", type=float, default=32.0)
    parser.add_argument("--correction-weight", type=float, default=16.0)
    parser.add_argument("--negative-ratio", type=float, default=6.0)
    parser.add_argument("--negative-min", type=int, default=1024)
    parser.add_argument("--negative-weight", type=float, default=0.75)
    parser.add_argument("--identity-loss-weight", type=float, default=2.0)
    parser.add_argument("--dice-weight", type=float, default=0.5)
    parser.add_argument("--exact-replay-probability", type=float, default=0.0,
                        help="probability of retaining exact mask geometry for "
                             "a training sample while still applying colour "
                             "jitter; useful for sparse one-pixel edits")
    parser.add_argument("--validation-threshold", type=float, default=0.5)
    parser.add_argument("--no-change-logit", type=float, default=4.0)
    parser.add_argument("--action-logit", type=float, default=-4.0)
    parser.add_argument("--device",
                        default="cuda" if torch.cuda.is_available() else "cpu")
    return parser.parse_args()


class LayerRefinerPairs(Dataset):
    def __init__(self, items, size=512, train=True, seed=0,
                 exact_replay_probability=0.0):
        self.items = items
        self.size = int(size)
        self.train = bool(train)
        self.seed = int(seed)
        self.exact_replay_probability = float(exact_replay_probability)
        if not 0.0 <= self.exact_replay_probability <= 1.0:
            raise ValueError("exact replay probability must be between 0 and 1")

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
        base_back = self._read(os.path.join(directory, "base_back.png"),
                               cv2.IMREAD_GRAYSCALE)
        target_full = self._read(os.path.join(directory, "full.png"),
                                 cv2.IMREAD_GRAYSCALE)
        target_back = self._read(os.path.join(directory, "back.png"),
                                 cv2.IMREAD_GRAYSCALE)
        rgb = rgba[..., :3].astype(np.float32)
        base_full = rgba[..., 3].astype(np.float32) / 255.0
        base_back = base_back.astype(np.float32) / 255.0
        target_full = target_full.astype(np.float32) / 255.0
        target_back = target_back.astype(np.float32) / 255.0

        rng_seed = ((torch.initial_seed() if self.train else self.seed) +
                    0x9E3779B1 * (index + 1)) % (2 ** 63 - 1)
        rng = np.random.default_rng(rng_seed)
        augment_geometry = (self.train and
                            rng.random() >= self.exact_replay_probability)
        if augment_geometry:
            height, width = base_full.shape
            matrix = cv2.getRotationMatrix2D(
                (width / 2, height / 2), rng.uniform(-6, 6),
                rng.uniform(0.92, 1.08))
            matrix[0, 2] += rng.uniform(-0.015, 0.015) * width
            matrix[1, 2] += rng.uniform(-0.015, 0.015) * height
            rgb = cv2.warpAffine(rgb, matrix, (width, height),
                                 flags=cv2.INTER_LINEAR,
                                 borderValue=(247, 247, 247))
            arrays = []
            for array in (base_full, base_back, target_full, target_back):
                arrays.append(cv2.warpAffine(
                    array, matrix, (width, height),
                    flags=cv2.INTER_NEAREST, borderValue=0))
            base_full, base_back, target_full, target_back = arrays
            if rng.random() < 0.5:
                rgb = rgb[:, ::-1]
                base_full, base_back = base_full[:, ::-1], base_back[:, ::-1]
                target_full = target_full[:, ::-1]
                target_back = target_back[:, ::-1]

        size = self.size
        rgb = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_AREA)
        arrays = []
        for array in (base_full, base_back, target_full, target_back):
            arrays.append(cv2.resize(array, (size, size),
                                     interpolation=cv2.INTER_NEAREST))
        base_full, base_back, target_full, target_back = arrays
        base_full = (base_full > 0.5).astype(np.float32)
        base_back = (base_back > 0.5).astype(np.float32) * base_full
        target_full = (target_full > 0.5).astype(np.float32)
        target_back = (target_back > 0.5).astype(np.float32) * target_full
        if self.train:
            rgb = rgb * rng.uniform(0.94, 1.06) + rng.uniform(-4, 4)
        rgb = np.clip(rgb, 0, 255) / 255.0

        def tensor(array):
            return torch.from_numpy(np.ascontiguousarray(array).astype(np.float32))

        full_tensor = tensor(base_full[None])
        back_tensor = tensor(base_back[None])
        target_full_tensor = tensor(target_full[None])
        target_back_tensor = tensor(target_back[None])
        labels = transition_targets(
            full_tensor, back_tensor, target_full_tensor,
            target_back_tensor).squeeze(0)
        is_correction = float(
            cached_meta(item).get("target_source") == "reviewed_correction")
        return (tensor(rgb.transpose(2, 0, 1)), full_tensor, back_tensor,
                target_full_tensor, target_back_tensor, labels,
                torch.tensor(is_correction, dtype=torch.float32))


def sparse_action_loss(logits, labels, *, negative_ratio=6.0,
                       negative_min=1024, negative_weight=0.75,
                       dice_weight=0.5, identity_loss_weight=2.0):
    """Balance sparse edits per image and mine the most dangerous negatives."""
    pixel_loss = F.cross_entropy(logits, labels, reduction="none")
    probabilities = logits.softmax(dim=1)
    losses = []
    for index in range(len(logits)):
        positive = labels[index] != 0
        negative_values = pixel_loss[index][~positive]
        positive_count = int(positive.sum())
        if positive_count:
            positive_loss = pixel_loss[index][positive].mean()
            negative_count = min(
                len(negative_values),
                max(int(negative_min),
                    int(round(float(negative_ratio) * positive_count))))
            hard_negative = negative_values.topk(negative_count).values.mean()
            class_dice = []
            for action_class in (1, 2, 3):
                target = (labels[index] == action_class).to(logits.dtype)
                if not bool(target.any()):
                    continue
                predicted = probabilities[index, action_class]
                intersection = (predicted * target).sum()
                class_dice.append(
                    1.0 - (2.0 * intersection + 1.0) /
                    (predicted.sum() + target.sum() + 1.0))
            overlap_loss = torch.stack(class_dice).mean() if class_dice else 0.0
            losses.append(positive_loss + float(negative_weight) * hard_negative +
                          float(dice_weight) * overlap_loss)
        else:
            negative_count = min(len(negative_values), int(negative_min))
            losses.append(float(identity_loss_weight) *
                          negative_values.topk(negative_count).values.mean())
    return torch.stack(losses).mean()


def errors_per_sample(full, back, target_full, target_back):
    return (((full != target_full).sum((1, 2, 3)) +
             (back != target_back).sum((1, 2, 3))).float())


def summarize(rows, correction):
    selected = [row for row in rows if row["correction"] == correction]
    if not selected:
        return {"cases": 0}
    deltas = [row["baseline_errors"] - row["candidate_errors"]
              for row in selected]
    normalizers = [max(row["target_pixels"], 1) for row in selected]
    return {
        "cases": len(selected),
        "baseline_errors": int(sum(row["baseline_errors"] for row in selected)),
        "candidate_errors": int(sum(row["candidate_errors"] for row in selected)),
        "mean_error_reduction": float(np.mean([
            delta / normalizer for delta, normalizer in zip(deltas, normalizers)
        ])),
        "improved": sum(delta > 0 for delta in deltas),
        "tied": sum(delta == 0 for delta in deltas),
        "regressed": sum(delta < 0 for delta in deltas),
        "changed_cases": sum(row["action_pixels"] > 0 for row in selected),
        "action_pixels": int(sum(row["action_pixels"] for row in selected)),
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
                metadata.get("target_source") == "reviewed_identity" and
                design_of(item) in holdouts)
            (val_items if corrected_holdout or related_identity else
             train_items).append(item)
        val_keys = sorted({design_of(item) for item in val_items})
    if args.final_fit_all:
        train_items = list(items)
        val_items = list(items)
        val_keys = sorted({design_of(item) for item in items})

    corrected_train = sum(cached_meta(item).get("target_source") ==
                          "reviewed_correction" for item in train_items)
    corrected_val = sum(cached_meta(item).get("target_source") ==
                        "reviewed_correction" for item in val_items)
    print(f"[i] {len(items)} items / {len(groups)} groups -> "
          f"{len(train_items)} train / {len(val_items)} family holdout")
    print(f"[i] reviewed corrections -> {corrected_train} train / "
          f"{corrected_val} holdout")
    manifest = {
        "args": vars(args),
        "fingerprint": data_fingerprint(items),
        "train_designs": sorted({design_of(item) for item in train_items}),
        "val_designs": sorted(val_keys),
    }
    hard_negative_ids = set()
    hard_positive_ids = set()
    if args.hard_negative_evaluation:
        evaluation = json.loads(Path(args.hard_negative_evaluation).read_text())
        if args.hard_negative_class_threshold:
            expected_threshold = [float(value) for value in
                                  args.hard_negative_class_threshold.split(",")]
            if len(expected_threshold) != 3:
                raise ValueError("hard-negative class threshold needs three values")
            threshold_matches = lambda value: value == expected_threshold
        else:
            threshold_matches = lambda value: (
                not isinstance(value, list) and
                abs(float(value) - args.hard_negative_threshold) < 1e-12)
        matches = [row for row in evaluation["evaluations"]
                   if threshold_matches(row["threshold"]) and
                   int(row.get("min_component", 0)) ==
                   args.hard_negative_min_component]
        if len(matches) != 1:
            raise ValueError("hard-negative evaluation setting is missing or ambiguous")
        hard_negative_ids = {
            row["id"] for row in matches[0]["rows"]
            if row["target_source"] == "reviewed_identity" and
            row["predicted_actions"] > 0
        }
        manifest["hard_negative_ids"] = sorted(hard_negative_ids)
        print(f"[i] hard negatives: {len(hard_negative_ids)} accepted cases")
    if args.hard_positive_evaluation:
        evaluation = json.loads(Path(args.hard_positive_evaluation).read_text())
        if args.hard_negative_class_threshold:
            expected_threshold = [float(value) for value in
                                  args.hard_negative_class_threshold.split(",")]
            threshold_matches = lambda value: value == expected_threshold
        else:
            threshold_matches = lambda value: (
                not isinstance(value, list) and
                abs(float(value) - args.hard_negative_threshold) < 1e-12)
        matches = [row for row in evaluation["evaluations"]
                   if threshold_matches(row["threshold"]) and
                   int(row.get("min_component", 0)) ==
                   args.hard_negative_min_component]
        if len(matches) != 1:
            raise ValueError("hard-positive evaluation setting is missing or ambiguous")
        hard_positive_ids = {
            row["id"] for row in matches[0]["rows"]
            if row["target_source"] == "reviewed_correction" and
            row["expected_actions"] > 0 and
            row["candidate_errors"] >= row["baseline_errors"]
        }
        manifest["hard_positive_ids"] = sorted(hard_positive_ids)
        print(f"[i] hard positives: {len(hard_positive_ids)} difficult cases")
    with open(os.path.join(args.out, "split.json"), "w") as handle:
        json.dump(manifest, handle, indent=2)

    weights = []
    for item in train_items:
        metadata = cached_meta(item)
        case_id = metadata.get("benchmark_case", Path(item[0]).parent.name)
        if case_id in hard_positive_ids:
            weight = args.hard_positive_weight
        elif metadata.get("target_source") == "reviewed_correction":
            weight = args.correction_weight
        elif case_id in hard_negative_ids:
            weight = args.hard_negative_weight
        else:
            weight = 1.0
        weights.append(weight)
    sampler = WeightedRandomSampler(
        weights, len(train_items), replacement=True,
        generator=torch.Generator().manual_seed(args.seed))
    train_loader = DataLoader(
        LayerRefinerPairs(
            train_items, args.size, True, args.seed,
            exact_replay_probability=args.exact_replay_probability),
        batch_size=args.batch, sampler=sampler, num_workers=args.workers,
        pin_memory=True)
    val_loader = DataLoader(
        LayerRefinerPairs(val_items, args.size, False, args.seed),
        batch_size=args.batch, shuffle=False, num_workers=args.workers,
        pin_memory=True)

    model = LayerRefiner(args.no_change_logit, args.action_logit).to(args.device)
    if args.init:
        initial = torch.load(args.init, map_location="cpu", weights_only=False)
        if initial.get("architecture") != LayerRefiner.architecture:
            raise ValueError("initial checkpoint is not a final-layer refiner")
        model.load_state_dict(initial["refiner"])
        print(f"[i] initialized from {args.init} (epoch {initial.get('epoch')})")
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr,
                                  weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr,
        total_steps=max(args.epochs * len(train_loader), 1), pct_start=0.2)
    scaler = torch.amp.GradScaler(enabled=args.device.startswith("cuda"))
    best_score = -float("inf")
    val_names = [Path(item[0]).parent.name for item in val_items]
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        seen = 0
        started = time.time()
        for rgb, full, back, _, _, labels, _ in train_loader:
            rgb, full = rgb.to(args.device), full.to(args.device)
            back, labels = back.to(args.device), labels.to(args.device)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=args.device.startswith("cuda")):
                logits = model(rgb, full, back)
                loss = sparse_action_loss(
                    logits, labels, negative_ratio=args.negative_ratio,
                    negative_min=args.negative_min,
                    negative_weight=args.negative_weight,
                    dice_weight=args.dice_weight,
                    identity_loss_weight=args.identity_loss_weight)
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
            for (rgb, full, back, target_full, target_back, _,
                 correction) in val_loader:
                logits = model(rgb.to(args.device), full.to(args.device),
                               back.to(args.device)).cpu()
                candidate_full, candidate_back, actions = apply_layer_actions(
                    full, back, logits, threshold=args.validation_threshold)
                expected_full = target_full > 0.5
                expected_back = target_back > 0.5
                baseline_errors = errors_per_sample(
                    full > 0.5, back > 0.5, expected_full, expected_back)
                candidate_errors = errors_per_sample(
                    candidate_full, candidate_back, expected_full, expected_back)
                target_pixels = (expected_full.sum((1, 2, 3)) +
                                 expected_back.sum((1, 2, 3))).float()
                for index in range(len(rgb)):
                    rows.append({
                        "name": val_names[cursor + index],
                        "correction": bool(correction[index]),
                        "baseline_errors": int(baseline_errors[index]),
                        "candidate_errors": int(candidate_errors[index]),
                        "target_pixels": int(target_pixels[index]),
                        "action_pixels": int((actions[index] != 0).sum()),
                    })
                cursor += len(rgb)
        correction_summary = summarize(rows, True)
        identity_summary = summarize(rows, False)
        identity_pixels = max(identity_summary.get("action_pixels", 0), 0)
        score = (correction_summary.get("mean_error_reduction", 0.0) -
                 0.00001 * identity_pixels +
                 0.0001 * correction_summary.get("improved", 0))
        checkpoint = {
            "architecture": LayerRefiner.architecture,
            "refiner": model.state_dict(),
            "size": args.size,
            "no_change_logit": args.no_change_logit,
            "action_logit": args.action_logit,
            "epoch": epoch,
            "selection_score": score,
            "correction_validation": correction_summary,
            "identity_validation": identity_summary,
            "validation_cases": rows,
            "data_fingerprint": manifest["fingerprint"],
            "args": vars(args),
        }
        path = os.path.join(args.out, f"epoch_{epoch:03d}.pt")
        torch.save(checkpoint, path)
        torch.save(checkpoint, os.path.join(args.out, "last.pt"))
        if score > best_score:
            best_score = score
            torch.save(checkpoint, os.path.join(args.out, "best.pt"))
        print(f"ep {epoch:3d} loss {total/max(seen,1):.4f} corrected "
              f"I/T/R {correction_summary.get('improved', 0)}/"
              f"{correction_summary.get('tied', 0)}/"
              f"{correction_summary.get('regressed', 0)} errors "
              f"{correction_summary.get('candidate_errors', 0)}/"
              f"{correction_summary.get('baseline_errors', 0)} identity "
              f"changed {identity_summary.get('changed_cases', 0)} cases / "
              f"{identity_summary.get('action_pixels', 0)} px "
              f"({time.time()-started:.0f}s)")
    print(f"[ok] best score {best_score:.6f} -> {args.out}")


if __name__ == "__main__":
    main()
