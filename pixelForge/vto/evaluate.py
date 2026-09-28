"""Evaluate a checkpoint on its design-held-out cache split.

Reports both item-weighted and physical-design-balanced metrics.  The latter is
the useful headline because API products may have many near-identical variants.

Holdout validity follows initialization, teacher and fusion dependencies.
``strict_holdout`` is null (unknown) when lineage evidence is incomplete,
false when a training overlap is known, and true only for a complete clean
recorded lineage. Overlap counts are lower bounds when provenance is incomplete.

    python -m vto.evaluate --data data/cache --ckpt vto/runs/v6_eval/best.pt
"""

import argparse
import json
import os
from collections import defaultdict

import numpy as np
import torch
from torch.utils.data import DataLoader

from vto.data import CachedPairs, cached_name, design_of, family_of, find_cached
from vto.model import model_from_checkpoint
from vto.provenance import holdout_validity


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--ckpt", required=True)
    p.add_argument("--split", default=None,
                   help="split.json (defaults to the checkpoint directory)")
    p.add_argument("--out", default=None, help="optional JSON report path")
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--thr", type=float, default=0.5)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    return p.parse_args()


def _average(rows):
    fields = ("matte_iou", "back_iou", "back_precision", "back_recall")
    return {field: round(float(np.mean([r.get(field) for r in rows
                                       if r.get(field) is not None])), 6)
            for field in fields
            if any(r.get(field) is not None for r in rows)}


def aggregate(rows):
    designs = defaultdict(list)
    for row in rows:
        designs[row["design"]].append(row)
    design_rows = []
    for design, views in designs.items():
        design_rows.append({"design": design, "family": views[0]["family"],
                            **_average(views)})

    families = {}
    for family in sorted({r["family"] for r in design_rows}):
        selected = [r for r in design_rows if r["family"] == family]
        families[family] = {"designs": len(selected), **_average(selected)}
        supervised = [r for r in selected if r.get("back_iou") is not None]
        if supervised:
            families[family]["back_failures_below_0.50"] = sum(
                r["back_iou"] < 0.50 for r in supervised)

    return {
        "items": len(rows),
        "designs": len(design_rows),
        "item_weighted": _average(rows),
        "design_balanced": _average(design_rows),
        "families": families,
        "worst_back_designs": sorted(
            (r for r in design_rows if r.get("back_iou") is not None),
            key=lambda r: r["back_iou"])[:10],
    }


@torch.no_grad()
def main():
    args = parse_args()
    split_path = args.split or os.path.join(os.path.dirname(args.ckpt), "split.json")
    with open(split_path) as f:
        split = json.load(f)
    val_designs = set(split["val_designs"])
    if not val_designs:
        raise SystemExit("validation design list is empty")
    items = [x for x in find_cached(args.data) if design_of(x) in val_designs]
    missing = val_designs - {design_of(x) for x in items}
    if missing:
        raise SystemExit(f"validation designs missing from cache: {sorted(missing)}")

    checkpoint = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    if (checkpoint.get("data_fingerprint") and split.get("fingerprint") and
            checkpoint["data_fingerprint"] != split["fingerprint"]):
        raise SystemExit("checkpoint and split.json were produced from different caches")
    size = int(checkpoint.get("size", 384))
    model = model_from_checkpoint(checkpoint).to(args.device).eval()
    loader = DataLoader(CachedPairs(items, size, False), batch_size=args.batch,
                        shuffle=False, num_workers=args.workers, pin_memory=True)

    rows = []
    cursor = 0
    for x, y, weight in loader:
        logits = model(x.to(args.device, non_blocking=True))
        pred = (torch.sigmoid(logits).cpu() > args.thr)
        truth = y > 0.5
        tp = (pred & truth).sum((2, 3)).numpy()
        pred_n = pred.sum((2, 3)).numpy()
        truth_n = truth.sum((2, 3)).numpy()
        union = (pred | truth).sum((2, 3)).numpy()
        for j in range(len(x)):
            item = items[cursor + j]
            has_back = bool(weight[j, 1])
            rows.append({
                "name": cached_name(item),
                "design": design_of(item),
                "family": family_of(item),
                "matte_iou": float(tp[j, 0] / max(union[j, 0], 1)),
                "back_iou": float(tp[j, 1] / max(union[j, 1], 1)) if has_back else None,
                "back_precision": float(tp[j, 1] / max(pred_n[j, 1], 1)) if has_back else None,
                "back_recall": float(tp[j, 1] / max(truth_n[j, 1], 1)) if has_back else None,
            })
        cursor += len(x)

    validity = holdout_validity(checkpoint, args.ckpt, split)

    report = {
        "checkpoint": os.path.abspath(args.ckpt),
        "epoch": checkpoint.get("epoch"),
        "threshold": args.thr,
        "validity": validity,
        **aggregate(rows),
    }
    print(json.dumps(report, indent=2))
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            json.dump(report, f, indent=2)


if __name__ == "__main__":
    main()
