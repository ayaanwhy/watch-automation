"""Train the front/back segmenter on retouched pairs.

    python -m vto.train --data data/pairs --epochs 60 --size 384 --batch 4
"""

import argparse
import hashlib
import json
import os
import time

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, WeightedRandomSampler

from vto.data import (CachedPairs, RingPairs, audit, cached_meta, design_of, family_of,
                      find_cached, find_pairs)
from vto.model import RingUNet, loss_fn


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True, help="root holding the full/front pairs")
    p.add_argument("--extra-data", action="append", default=[],
                   help="additional cached dataset root (repeatable; requires --cached)")
    p.add_argument("--cached", action="store_true",
                   help="--data points at vto.prepare output instead of raw pairs")
    p.add_argument("--out", default="vto/runs/base")
    p.add_argument("--epochs", type=int, default=60)
    p.add_argument("--batch", type=int, default=4)
    p.add_argument("--size", type=int, default=384)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--val-frac", type=float, default=0.15)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--halo-weight", type=float, default=12.0,
                   help="sampling multiplier for scarce edited halo designs")
    p.add_argument("--gem-weight", type=float, default=2.0,
                   help="sampling multiplier for matte-only gemstone examples")
    p.add_argument("--correction-weight", type=float, default=30.0,
                   help="sampling multiplier for reviewed benchmark corrections")
    p.add_argument("--force-train-family", action="append", default=[],
                   help="family whose designs must remain in training (repeatable)")
    p.add_argument("--edge-weight", type=float, default=0.0,
                   help="extra BCE weight in a narrow band around target contours")
    p.add_argument("--edge-radius", type=int, default=2,
                   help="radius in training pixels of the contour supervision band")
    p.add_argument("--back-edge-weight", type=float, default=0.0,
                   help="extra BCE weight around final rear-layer boundaries")
    p.add_argument("--back-teacher", default=None,
                   help="checkpoint whose production back logits constrain fine-tuning")
    p.add_argument("--back-distill-weight", type=float, default=0.0,
                   help="soft-target BCE weight used to preserve the teacher's back split")
    p.add_argument("--back-distill-agreement-only", action="store_true",
                   help="distill only pixels where the reviewed target and teacher agree")
    p.add_argument("--matte-teacher", default=None,
                   help="checkpoint whose matte logits constrain guarded fine-tuning")
    p.add_argument("--matte-distill-weight", type=float, default=0.0,
                   help="soft-target BCE weight used to preserve the teacher's matte")
    p.add_argument("--matte-distill-agreement-only", action="store_true",
                   help="distill matte only where reviewed target and teacher agree")
    p.add_argument("--freeze-matte-head", action="store_true",
                   help="keep the direct matte output weights fixed while fine-tuning")
    p.add_argument("--back-head-only", action="store_true",
                   help="train only the final back output projection; shared features stay exact")
    p.add_argument("--back-refine-only", action="store_true",
                   help="train only the two highest-resolution decoder blocks and output head")
    p.add_argument("--back-decoder-only", action="store_true",
                   help="train the UNet decoder and output head while freezing the encoder")
    p.add_argument("--keep-epochs", action="store_true",
                   help="save epoch_NNN.pt checkpoints for visual regression selection")
    p.add_argument("--include-multi-gems", action="store_true",
                   help="include optional synthetic multi-stone plates")
    p.add_argument("--holdout-design", action="append", default=[],
                   help="physical design id to force into validation (repeatable)")
    p.add_argument("--holdout-design-file", action="append", default=[],
                   help="JSON containing val_designs or holdout_designs (repeatable)")
    p.add_argument("--explicit-holdout-only", action="store_true",
                   help="disable random validation additions; requires a holdout")
    p.add_argument("--back-only-loss", action="store_true",
                   help="optimize only ownership; intended for a fused decoder")
    p.add_argument("--ownership-mode", choices=("legacy", "direct"),
                   default="legacy",
                   help="runtime target space recorded in exported model metadata")
    p.add_argument("--init", default=None, help="optional checkpoint to fine-tune")
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    return p.parse_args()


def split_groups(pairs, val_frac, seed, holdout_designs=(),
                 force_train_families=(), explicit_holdout_only=False):
    """Stratified physical-design split with no related views crossing sides."""
    groups = {}
    group_family = {}
    for item in pairs:
        key = design_of(item)
        fam = family_of(item)
        groups.setdefault(key, []).append(item)
        if key in group_family and group_family[key] != fam:
            raise ValueError(f"design {key!r} has mixed families")
        group_family[key] = fam

    unknown = sorted(set(holdout_designs) - set(groups))
    if unknown:
        raise ValueError(f"unknown --holdout-design values: {unknown}")

    forced_train = {key for key, family in group_family.items()
                    if family in set(force_train_families)}
    conflict = forced_train & set(holdout_designs)
    if conflict:
        raise ValueError(f"designs cannot be both holdout and forced train: {sorted(conflict)}")
    val_keys = set(holdout_designs)
    if explicit_holdout_only and not val_keys:
        raise ValueError("--explicit-holdout-only requires at least one holdout design")
    for fam in (() if explicit_holdout_only else
                sorted(set(group_family.values()))):
        keys = sorted(k for k, f in group_family.items() if f == fam)
        if len(keys) < 2:
            continue
        n_val = max(1, int(round(len(keys) * val_frac)))
        n_val = min(n_val, len(keys) - 1)
        already = sum(k in val_keys for k in keys)
        candidates = [k for k in keys if k not in val_keys and k not in forced_train]
        needed = min(max(n_val - already, 0), len(candidates))
        # Keep unrelated family splits unchanged when an explicit halo holdout
        # changes; Python's built-in hash is intentionally process-randomised.
        family_seed = int.from_bytes(hashlib.sha256(
            f"{seed}:{fam}".encode()).digest()[:8], "little")
        family_rng = np.random.default_rng(family_seed)
        val_keys.update(family_rng.permutation(candidates)[:needed].tolist())

    for fam in sorted(set(group_family.values())):
        keys = [k for k, f in group_family.items() if f == fam]
        if keys and all(k in val_keys for k in keys):
            raise ValueError(f"holdout consumes every {fam!r} design")

    train = [p for k in sorted(groups) if k not in val_keys for p in groups[k]]
    val = [p for k in sorted(groups) if k in val_keys for p in groups[k]]
    return train, val, groups, group_family, val_keys


def data_fingerprint(pairs):
    h = hashlib.sha256()
    for item in sorted(pairs, key=lambda x: x[0]):
        for path in item[:2]:
            st = os.stat(path)
            h.update(f"{os.path.abspath(path)}:{st.st_size}:{st.st_mtime_ns}\n".encode())
        h.update(json.dumps(cached_meta(item), sort_keys=True).encode())
        h.update(repr(tuple(item[2:])).encode())
    return h.hexdigest()


def holdout_designs_from_files(paths):
    designs = []
    for path in paths:
        with open(path) as handle:
            payload = json.load(handle)
        values = payload.get("holdout_designs", payload.get("val_designs"))
        if not isinstance(values, list) or not all(isinstance(x, str) for x in values):
            raise ValueError(
                f"{path} must contain a string list named holdout_designs or val_designs")
        designs.extend(values)
    return designs


def configure_finetune(model, *, back_head_only=False, back_refine_only=False,
                       back_decoder_only=False, freeze_matte_head=False):
    """Configure a narrowly scoped ownership fine-tune.

    Returns the modules whose BatchNorm statistics must remain frozen and an
    exact copy of the matte projection.  A zero gradient hook alone is not an
    exact freeze with AdamW because decoupled weight decay still changes the
    parameter, so the caller restores the copied projection after each step.
    """
    scopes = (back_head_only, back_refine_only, back_decoder_only)
    if sum(bool(scope) for scope in scopes) > 1:
        raise ValueError("ownership fine-tune scopes are mutually exclusive")

    frozen_modules = []
    if any(scopes):
        for parameter in model.parameters():
            parameter.requires_grad_(False)
        if back_head_only:
            trainable = (model.head,)
        elif back_refine_only:
            trainable = (model.up1, model.up0, model.head)
        else:
            trainable = (model.up4, model.up3, model.up2, model.up1,
                         model.up0, model.head)
        for module in trainable:
            module.requires_grad_(True)
        frozen_modules = [module for module in (
            model.stem, model.pool, model.l1, model.l2, model.l3, model.l4,
            model.up4, model.up3, model.up2, model.up1, model.up0,
        ) if module not in trainable]
        freeze_matte_head = True

    frozen_matte = None
    if freeze_matte_head:
        model.head.weight.register_hook(
            lambda grad: torch.cat([torch.zeros_like(grad[:1]), grad[1:]], dim=0))
        if model.head.bias is not None:
            model.head.bias.register_hook(
                lambda grad: torch.cat([torch.zeros_like(grad[:1]), grad[1:]], dim=0))
        frozen_matte = {
            "weight": model.head.weight[:1].detach().clone(),
            "bias": (model.head.bias[:1].detach().clone()
                     if model.head.bias is not None else None),
        }
    return frozen_modules, frozen_matte, freeze_matte_head


@torch.no_grad()
def restore_matte_projection(model, frozen_matte):
    if frozen_matte is None:
        return
    model.head.weight[:1].copy_(frozen_matte["weight"])
    if model.head.bias is not None:
        model.head.bias[:1].copy_(frozen_matte["bias"])


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    torch.manual_seed(args.seed)
    args.holdout_design.extend(holdout_designs_from_files(
        args.holdout_design_file))
    args.holdout_design = sorted(set(args.holdout_design))

    if args.cached:
        pairs = []
        seen = set()
        for root in [args.data, *args.extra_data]:
            for pair in find_cached(root):
                key = os.path.abspath(pair[0])
                if key not in seen:
                    seen.add(key)
                    pairs.append(pair)
        if not args.include_multi_gems:
            pairs = [p for p in pairs
                     if cached_meta(p).get("source") != "synthetic_multi"]
        print(f"[i] {len(pairs)} cached pairs")
    else:
        pairs = find_pairs(args.data)
        pairs, rejected = audit(pairs)
        print(f"[i] {len(pairs)} usable pairs ({len(rejected)} rejected)")
    if not pairs:
        raise SystemExit(f"no pairs under {args.data}")
    Pairs = CachedPairs if args.cached else RingPairs
    train_pairs, val_pairs, groups, group_family, val_keys = split_groups(
        pairs, args.val_frac, args.seed, args.holdout_design,
        args.force_train_family, args.explicit_holdout_only)
    keys = sorted(groups)
    print(f"[i] {len(pairs)} pairs across {len(keys)} physical designs -> "
          f"{len(train_pairs)} train / {len(val_pairs)} val "
          f"({len(keys)-len(val_keys)} / {len(val_keys)} designs, no design leakage)")

    manifest = {
        "args": vars(args),
        "fingerprint": data_fingerprint(pairs),
        "train_designs": sorted(set(design_of(p) for p in train_pairs)),
        "val_designs": sorted(val_keys),
        "family_design_counts": {
            fam: sum(f == fam for f in group_family.values())
            for fam in sorted(set(group_family.values()))
        },
    }
    with open(os.path.join(args.out, "split.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    weights = []
    for item in train_pairs:
        fam = family_of(item)
        meta = cached_meta(item)
        is_correction = (fam == "correction" or
                         meta.get("target_source") == "reviewed_correction")
        weights.append(args.correction_weight if is_correction else
                       args.halo_weight if fam == "halo" else
                       args.gem_weight if fam == "gem" else 1.0)
    generator = torch.Generator().manual_seed(args.seed)
    sampler = WeightedRandomSampler(weights, num_samples=len(train_pairs),
                                    replacement=True, generator=generator)
    train_dataset = (CachedPairs(train_pairs, args.size, True, args.seed,
                                 return_pixel_weight=True)
                     if args.cached else RingPairs(train_pairs, args.size, True,
                                                   args.seed))
    tl = DataLoader(train_dataset,
                    batch_size=args.batch, sampler=sampler, num_workers=args.workers,
                    drop_last=len(train_pairs) > args.batch, pin_memory=True)
    vl = DataLoader(Pairs(val_pairs, args.size, False), batch_size=args.batch,
                    shuffle=False, num_workers=args.workers, pin_memory=True)

    model = RingUNet(pretrained=args.init is None).to(args.device)
    if args.init:
        initial = torch.load(args.init, map_location="cpu", weights_only=False)
        model.load_state_dict(initial["model"])
    frozen_modules, frozen_matte, args.freeze_matte_head = configure_finetune(
        model, back_head_only=args.back_head_only,
        back_refine_only=args.back_refine_only,
        back_decoder_only=args.back_decoder_only,
        freeze_matte_head=args.freeze_matte_head)
    teacher = None
    teacher_size = None
    if args.back_teacher:
        teacher_checkpoint = torch.load(args.back_teacher, map_location="cpu",
                                        weights_only=False)
        teacher_size = int(teacher_checkpoint.get("size", args.size))
        teacher = RingUNet(pretrained=False).to(args.device).eval()
        teacher.load_state_dict(teacher_checkpoint["model"])
        teacher.requires_grad_(False)
    matte_teacher = None
    matte_teacher_size = None
    if args.matte_teacher and args.matte_teacher == args.back_teacher:
        matte_teacher = teacher
        matte_teacher_size = teacher_size
    elif args.matte_teacher:
        matte_checkpoint = torch.load(args.matte_teacher, map_location="cpu",
                                      weights_only=False)
        matte_teacher_size = int(matte_checkpoint.get("size", args.size))
        matte_teacher = RingUNet(pretrained=False).to(args.device).eval()
        matte_teacher.load_state_dict(matte_checkpoint["model"])
        matte_teacher.requires_grad_(False)
    trainable_parameters = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(trainable_parameters, lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=max(args.epochs * len(tl), 1), pct_start=0.25)
    scaler = torch.amp.GradScaler(enabled=args.device.startswith("cuda"))

    best = best_back = best_matte = best_halo = -1.0
    val_families = [family_of(p) for p in val_pairs]
    for ep in range(1, args.epochs + 1):
        model.train()
        # Frozen BatchNorm statistics are part of the deployed feature
        # extractor.  Updating them would move both channels despite the
        # corresponding weights being frozen.
        for module in frozen_modules:
            module.eval()
        train_loss = 0.0; seen = 0; t0 = time.time()
        for batch in tl:
            x, y, w = batch[:3]
            pixel_weight = batch[3] if len(batch) == 4 else None
            x = x.to(args.device, non_blocking=True)
            y = y.to(args.device, non_blocking=True)
            w = w.to(args.device, non_blocking=True)
            if args.back_only_loss:
                w = w.clone()
                w[:, 0] = 0.0
            if pixel_weight is not None:
                pixel_weight = pixel_weight.to(args.device, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=args.device.startswith("cuda")):
                logits = model(x)
                loss = loss_fn(logits, y, sample_weight=w,
                               pixel_weight=pixel_weight,
                               edge_weight=args.edge_weight,
                               edge_radius=args.edge_radius,
                               back_edge_weight=args.back_edge_weight)
                if teacher is not None and args.back_distill_weight > 0:
                    with torch.no_grad():
                        teacher_x = F.interpolate(x, size=(teacher_size, teacher_size),
                                                  mode="bilinear", align_corners=False)
                        teacher_back = teacher(teacher_x)[:, 1:2]
                        teacher_back = F.interpolate(
                            teacher_back, size=logits.shape[-2:], mode="bilinear",
                            align_corners=False).sigmoid()
                    back_distill_pixels = F.binary_cross_entropy_with_logits(
                        logits[:, 1:2], teacher_back, reduction="none")
                    if args.back_distill_agreement_only:
                        agreement = ((teacher_back > 0.5) ==
                                     (y[:, 1:2] > 0.5)).float()
                        back_distill = ((back_distill_pixels * agreement).sum() /
                                        agreement.sum().clamp(min=1.0))
                    else:
                        back_distill = back_distill_pixels.mean()
                    loss = loss + args.back_distill_weight * back_distill
                if matte_teacher is not None and args.matte_distill_weight > 0:
                    with torch.no_grad():
                        matte_x = F.interpolate(x, size=(matte_teacher_size,
                                                         matte_teacher_size),
                                               mode="bilinear", align_corners=False)
                        teacher_matte = matte_teacher(matte_x)[:, :1]
                        teacher_matte = F.interpolate(
                            teacher_matte, size=logits.shape[-2:], mode="bilinear",
                            align_corners=False).sigmoid()
                    matte_distill_pixels = F.binary_cross_entropy_with_logits(
                        logits[:, :1], teacher_matte, reduction="none")
                    if args.matte_distill_agreement_only:
                        agreement = ((teacher_matte > 0.5) ==
                                     (y[:, :1] > 0.5)).float()
                        matte_distill = ((matte_distill_pixels * agreement).sum() /
                                         agreement.sum().clamp(min=1.0))
                    else:
                        matte_distill = matte_distill_pixels.mean()
                    loss = loss + args.matte_distill_weight * matte_distill
            scaler.scale(loss).backward()
            scaler.step(opt); scaler.update()
            restore_matte_projection(model, frozen_matte)
            sched.step()
            train_loss += float(loss) * x.size(0)
            seen += x.size(0)

        model.eval()
        val_sum = torch.zeros(2)
        val_count = torch.zeros(2)
        family_sum = {}
        family_count = {}
        cursor = 0
        with torch.no_grad():
            for x, y, w in vl:
                x, y, w = x.to(args.device), y.to(args.device), w.to(args.device)
                with torch.amp.autocast("cuda", enabled=args.device.startswith("cuda")):
                    logits = model(x)
                pred = (torch.sigmoid(logits) > 0.5).float()
                truth = (y > 0.5).float()
                inter = (pred * truth).sum(dim=(2, 3))
                union = ((pred + truth) > 0).float().sum(dim=(2, 3))
                per = (inter / union.clamp(min=1)).float().cpu()
                mask = (w > 0).float().cpu()
                val_sum += (per * mask).sum(0)
                val_count += mask.sum(0)
                for j in range(len(x)):
                    fam = val_families[cursor + j]
                    family_sum.setdefault(fam, torch.zeros(2)).add_(per[j] * mask[j])
                    family_count.setdefault(fam, torch.zeros(2)).add_(mask[j])
                cursor += len(x)
        metrics = val_sum / val_count.clamp(min=1)
        alpha_iou, back_iou = float(metrics[0]), float(metrics[1])
        family_iou = {f: family_sum[f] / family_count[f].clamp(min=1)
                      for f in family_sum}
        ring_family_back = [float(v[1]) for f, v in family_iou.items()
                            if family_count[f][1] > 0]
        family_back_iou = float(np.mean(ring_family_back)) if ring_family_back else 0.0
        score = family_back_iou + 0.10 * alpha_iou
        halo_iou = float(family_iou.get("halo", torch.zeros(2))[1])
        print(f"ep {ep:3d}  loss {train_loss/max(seen,1):.4f}  "
              f"val matte IoU {alpha_iou:.3f}  val back IoU {back_iou:.3f}  "
              f"family back {family_back_iou:.3f}  halo {halo_iou:.3f}  "
              f"({time.time()-t0:.0f}s)")

        checkpoint = {
            "model": model.state_dict(), "size": args.size, "epoch": ep,
            "ownership_mode": args.ownership_mode,
            "matte_iou": alpha_iou, "back_iou": back_iou,
            "family_back_iou": family_back_iou, "halo_iou": halo_iou,
            "selection_score": score, "data_fingerprint": manifest["fingerprint"],
            "args": vars(args),
        }
        torch.save(checkpoint, os.path.join(args.out, "last.pt"))
        if args.keep_epochs:
            torch.save(checkpoint, os.path.join(args.out, f"epoch_{ep:03d}.pt"))
        if score > best:
            best = score
            torch.save(checkpoint, os.path.join(args.out, "best.pt"))
        if back_iou > best_back:
            best_back = back_iou
            torch.save(checkpoint, os.path.join(args.out, "best_back.pt"))
        if alpha_iou > best_matte:
            best_matte = alpha_iou
            torch.save(checkpoint, os.path.join(args.out, "best_matte.pt"))
        if halo_iou > best_halo:
            best_halo = halo_iou
            torch.save(checkpoint, os.path.join(args.out, "best_halo.pt"))
    print(f"[✓] best selection score {best:.3f}, back {best_back:.3f}, "
          f"matte {best_matte:.3f} -> {args.out}")


if __name__ == "__main__":
    main()
