"""Train a matte-only edge refiner on top of a frozen semantic checkpoint."""

import argparse
import json
import os
import time

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, WeightedRandomSampler

from vto.data import CachedPairs, cached_meta, design_of, family_of, find_cached
from vto.model import boundary_band
from vto.refiner import HybridRingModel, MatteRefiner
from vto.model import RingUNet
from vto.train import data_fingerprint, split_groups


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--base", required=True)
    p.add_argument("--out", default="vto/runs/refiner")
    p.add_argument("--epochs", type=int, default=10)
    p.add_argument("--batch", type=int, default=2)
    p.add_argument("--size", type=int, default=512)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--val-frac", type=float, default=0.15)
    p.add_argument("--holdout-design", action="append", default=[])
    p.add_argument("--exclude-design", action="append", default=[],
                   help="design id to omit completely (may be repeated)")
    p.add_argument("--band-radius", type=int, default=8)
    p.add_argument("--edge-weight", type=float, default=4.0)
    p.add_argument("--edge-radius", type=int, default=2)
    p.add_argument("--real-background-weight", type=float, default=8.0)
    p.add_argument("--halo-weight", type=float, default=30.0)
    p.add_argument("--gem-weight", type=float, default=3.0)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    return p.parse_args()


def matte_loss(logit, target, edge_weight=4.0, edge_radius=2):
    pixels = F.binary_cross_entropy_with_logits(logit, target, reduction="none")
    weight = 1.0 + edge_weight * boundary_band(target, edge_radius)
    bce = (pixels * weight).sum() / weight.sum().clamp(min=1)
    p = logit.sigmoid()
    dice = 1.0 - ((2 * (p * target).sum() + 1) /
                  (p.sum() + target.sum() + 1))
    return bce + dice


def boundary_f1(pred, truth):
    values = []
    kernel = np.ones((3, 3), np.uint8)
    for p, t in zip(pred, truth):
        pe = cv2.morphologyEx(p.astype(np.uint8), cv2.MORPH_GRADIENT, kernel)
        te = cv2.morphologyEx(t.astype(np.uint8), cv2.MORPH_GRADIENT, kernel)
        pd = cv2.dilate(pe, kernel) > 0
        td = cv2.dilate(te, kernel) > 0
        pe, te = pe > 0, te > 0
        precision = (pe & td).sum() / max(pe.sum(), 1)
        recall = (te & pd).sum() / max(te.sum(), 1)
        values.append(2 * precision * recall / max(precision + recall, 1e-9))
    return values


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    torch.manual_seed(args.seed)
    excluded = set(args.exclude_design)
    items = [x for x in find_cached(args.data)
             if cached_meta(x).get("source") != "synthetic_multi"
             and design_of(x) not in excluded]
    train_items, val_items, groups, families, val_keys = split_groups(
        items, args.val_frac, args.seed, args.holdout_design)
    print(f"[i] {len(items)} items / {len(groups)} designs -> "
          f"{len(train_items)} train / {len(val_items)} val")
    manifest = {
        "args": vars(args), "fingerprint": data_fingerprint(items),
        "train_designs": sorted(set(design_of(x) for x in train_items)),
        "val_designs": sorted(val_keys),
    }
    with open(os.path.join(args.out, "split.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    weights = []
    for item in train_items:
        meta = cached_meta(item)
        weight = (args.halo_weight if family_of(item) == "halo" else
                  args.gem_weight if family_of(item) == "gem" else 1.0)
        if meta.get("real_background"):
            weight *= args.real_background_weight
        weights.append(weight)
    sampler = WeightedRandomSampler(weights, len(train_items), replacement=True,
                                    generator=torch.Generator().manual_seed(args.seed))
    train_loader = DataLoader(CachedPairs(train_items, args.size, True, args.seed),
                              batch_size=args.batch, sampler=sampler,
                              num_workers=args.workers, pin_memory=True)
    val_loader = DataLoader(CachedPairs(val_items, args.size, False, args.seed),
                            batch_size=args.batch, shuffle=False,
                            num_workers=args.workers, pin_memory=True)

    base_ckpt = torch.load(args.base, map_location="cpu", weights_only=False)
    base = RingUNet(pretrained=False)
    base.load_state_dict(base_ckpt["model"])
    base.requires_grad_(False).eval()
    refiner = MatteRefiner(args.band_radius)
    model = HybridRingModel(base, refiner, int(base_ckpt.get("size", 384)))
    model = model.to(args.device)
    model.base.eval()
    opt = torch.optim.AdamW(model.refiner.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=max(args.epochs * len(train_loader), 1),
        pct_start=0.25)
    scaler = torch.amp.GradScaler(enabled=args.device.startswith("cuda"))
    best = -1.0
    for epoch in range(1, args.epochs + 1):
        model.refiner.train(); model.base.eval(); total = 0.0; seen = 0; t0 = time.time()
        for x, y, _ in train_loader:
            x, target = x.to(args.device), y[:, :1].to(args.device)
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=args.device.startswith("cuda")):
                logit = model(x)[:, :1]
                loss = matte_loss(logit, target, args.edge_weight, args.edge_radius)
            scaler.scale(loss).backward(); scaler.step(opt); scaler.update(); sched.step()
            total += float(loss) * len(x); seen += len(x)

        model.eval(); inter = union = fp = fn = 0; bfs = []
        with torch.no_grad():
            for x, y, _ in val_loader:
                truth = y[:, :1] > 0.5
                pred = model(x.to(args.device))[:, :1].sigmoid().cpu() > 0.5
                inter += int((pred & truth).sum()); union += int((pred | truth).sum())
                fp += int((pred & ~truth).sum()); fn += int((~pred & truth).sum())
                bfs.extend(boundary_f1(pred[:, 0].numpy(), truth[:, 0].numpy()))
        iou = inter / max(union, 1); bf = float(np.mean(bfs))
        score = iou + 0.05 * bf
        checkpoint = {
            "refiner": model.refiner.state_dict(), "size": args.size,
            "base": os.path.abspath(args.base), "base_sha256": "",
            "band_radius": args.band_radius, "epoch": epoch,
            "matte_iou": iou, "boundary_f1": bf, "fp": fp, "fn": fn,
            "selection_score": score, "args": vars(args),
        }
        torch.save(checkpoint, os.path.join(args.out, f"epoch_{epoch:03d}.pt"))
        torch.save(checkpoint, os.path.join(args.out, "last.pt"))
        if score > best:
            best = score; torch.save(checkpoint, os.path.join(args.out, "best.pt"))
        print(f"ep {epoch:3d} loss {total/max(seen,1):.4f} val matte {iou:.4f} "
              f"boundary {bf:.4f} fp {fp} fn {fn} ({time.time()-t0:.0f}s)")
    print(f"[✓] best score {best:.4f} -> {args.out}")


if __name__ == "__main__":
    main()
