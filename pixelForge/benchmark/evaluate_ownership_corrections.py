"""Score reviewed layer-ownership corrections against one or more checkpoints.

This is deliberately separate from ``vto.evaluate``: correction examples are
forced into training and are a regression target, not an unbiased validation
set.  The report makes the repair strength reproducible while the ordinary
design-held-out report guards against collateral changes.

    python -m benchmark.evaluate_ownership_corrections \
        --data data/corrections/ownership-v1 \
        --ckpt vto/runs/v6_final/best.pt \
        --ckpt vto/runs/v10_ownership_refine_only/epoch_004.pt
"""

import argparse
import json
import os

import numpy as np
import torch
from torch.utils.data import DataLoader

from vto.data import CachedPairs, cached_name, design_of, find_cached
from vto.model import model_from_checkpoint


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--ckpt", action="append", required=True)
    parser.add_argument("--out", default=None)
    parser.add_argument("--split", default=None,
                        help="optional split.json; evaluate only its val_designs")
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--thr", type=float, default=0.5)
    parser.add_argument("--device",
                        default="cuda" if torch.cuda.is_available() else "cpu")
    return parser.parse_args()


def average(rows, field):
    return round(float(np.mean([row[field] for row in rows])), 6)


@torch.no_grad()
def evaluate(items, checkpoint_path, args):
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    size = int(checkpoint.get("size", 384))
    model = model_from_checkpoint(checkpoint).to(args.device).eval()
    loader = DataLoader(CachedPairs(items, size, False), batch_size=args.batch,
                        shuffle=False, num_workers=args.workers, pin_memory=True)

    rows = []
    cursor = 0
    for image, truth, _ in loader:
        logits = model(image.to(args.device, non_blocking=True))
        predicted = torch.sigmoid(logits).cpu() > args.thr
        expected = truth > 0.5
        intersection = (predicted & expected).sum((2, 3)).numpy()
        union = (predicted | expected).sum((2, 3)).numpy()
        for index in range(len(image)):
            rows.append({
                "name": cached_name(items[cursor + index]),
                "matte_iou": float(intersection[index, 0] /
                                   max(union[index, 0], 1)),
                "back_iou": float(intersection[index, 1] /
                                  max(union[index, 1], 1)),
            })
        cursor += len(image)

    return {
        "checkpoint": os.path.abspath(checkpoint_path),
        "epoch": checkpoint.get("epoch"),
        "items": len(rows),
        "matte_iou": average(rows, "matte_iou"),
        "back_iou": average(rows, "back_iou"),
        "worst_back": sorted(rows, key=lambda row: row["back_iou"])[:5],
        "cases": rows,
    }


def main():
    args = parse_args()
    items = find_cached(args.data)
    split = None
    if args.split:
        with open(args.split) as file:
            split = json.load(file)
        val_designs = set(split["val_designs"])
        items = [item for item in items if design_of(item) in val_designs]
        missing = val_designs - {design_of(item) for item in items}
        if missing:
            raise SystemExit(f"validation designs missing from data: {sorted(missing)}")
    if not items:
        raise SystemExit(f"no cached corrections under {args.data}")
    report = {
        "data": os.path.abspath(args.data),
        "split": os.path.abspath(args.split) if args.split else None,
        "threshold": args.thr,
        "models": [evaluate(items, checkpoint, args) for checkpoint in args.ckpt],
    }
    print(json.dumps(report, indent=2))
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as file:
            json.dump(report, file, indent=2)


if __name__ == "__main__":
    main()
