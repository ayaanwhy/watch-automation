#!/usr/bin/env python3
"""Interpolate a guarded ownership fine-tune with its stable base checkpoint."""

from __future__ import annotations

import argparse
import hashlib
import os

import torch


ENCODER_PREFIXES = ("stem.", "l1.", "l2.", "l3.", "l4.")


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--alpha", required=True, type=float,
                        help="candidate weight in [0, 1]")
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    if not 0.0 <= args.alpha <= 1.0:
        raise ValueError("--alpha must be between 0 and 1")
    base = torch.load(args.base, map_location="cpu", weights_only=False)
    candidate = torch.load(args.candidate, map_location="cpu", weights_only=False)
    if base.get("architecture", "ring_unet_v1") != candidate.get(
            "architecture", "ring_unet_v1"):
        raise ValueError("checkpoint architectures differ")
    if int(base.get("size", 384)) != int(candidate.get("size", 384)):
        raise ValueError("checkpoint sizes differ")
    if base["model"].keys() != candidate["model"].keys():
        raise ValueError("checkpoint state dictionaries differ")

    changed_encoder = [
        key for key in base["model"] if key.startswith(ENCODER_PREFIXES)
        and not torch.equal(base["model"][key], candidate["model"][key])
    ]
    if changed_encoder:
        raise ValueError(f"guarded checkpoints have different encoders: "
                         f"{changed_encoder[:5]}")

    blended = {}
    for key, base_value in base["model"].items():
        candidate_value = candidate["model"][key]
        if torch.is_floating_point(base_value):
            value = torch.lerp(base_value.float(), candidate_value.float(),
                               args.alpha).to(base_value.dtype)
        else:
            value = base_value.clone()
        blended[key] = value

    candidate_args = candidate.get("args") or {}
    payload = {
        **candidate,
        "model": blended,
        "epoch": f"blend-{args.alpha:g}",
        "args": {
            **candidate_args,
            "blend_base": os.path.abspath(args.base),
            "blend_candidate": os.path.abspath(args.candidate),
            "blend_alpha": args.alpha,
            "base_sha256": sha256(args.base),
            "candidate_sha256": sha256(args.candidate),
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    torch.save(payload, args.out)
    print(f"wrote {args.out}: {1.0 - args.alpha:.0%} base + "
          f"{args.alpha:.0%} candidate")


if __name__ == "__main__":
    main()
