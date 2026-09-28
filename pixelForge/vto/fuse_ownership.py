"""Fuse an approved matte checkpoint with a corrected ownership decoder.

The two checkpoints must have byte-identical encoders.  This invariant makes
the fused output exactly equal to ``matte_checkpoint[:, 0]`` and
``back_checkpoint[:, 1]`` while evaluating the shared encoder only once.
"""

import argparse
import os

import torch

from vto.model import DualDecoderRingUNet, RingUNet


ENCODER_PREFIXES = ("stem.", "l1.", "l2.", "l3.", "l4.")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--matte-ckpt", required=True)
    parser.add_argument("--back-ckpt", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def load_legacy(path):
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    if checkpoint.get("architecture", "ring_unet_v1") != "ring_unet_v1":
        raise ValueError(f"fusion input must be a RingUNet checkpoint: {path}")
    model = RingUNet(pretrained=False).eval()
    model.load_state_dict(checkpoint["model"])
    return checkpoint, model


def assert_identical_encoders(matte_state, back_state):
    keys = [key for key in matte_state if key.startswith(ENCODER_PREFIXES)]
    changed = [key for key in keys if not torch.equal(
        matte_state[key], back_state.get(key))]
    if changed:
        raise ValueError(f"checkpoints do not share an identical encoder: {changed[:5]}")


@torch.no_grad()
def main():
    args = parse_args()
    matte_checkpoint, matte_model = load_legacy(args.matte_ckpt)
    back_checkpoint, back_model = load_legacy(args.back_ckpt)
    if int(matte_checkpoint.get("size", 384)) != int(back_checkpoint.get("size", 384)):
        raise ValueError("fusion checkpoints use different input sizes")
    assert_identical_encoders(matte_checkpoint["model"], back_checkpoint["model"])

    fused = DualDecoderRingUNet(matte_model, back_model).eval()
    size = int(matte_checkpoint.get("size", 384))
    example = torch.rand(1, 3, size, size)
    expected = torch.cat((matte_model(example)[:, :1], back_model(example)[:, 1:2]), 1)
    torch.testing.assert_close(fused(example), expected, rtol=0, atol=0)

    payload = {
        "architecture": DualDecoderRingUNet.architecture,
        "model": fused.state_dict(),
        "size": size,
        "epoch": back_checkpoint.get("epoch"),
        "matte_iou": matte_checkpoint.get("matte_iou"),
        "back_iou": back_checkpoint.get("back_iou"),
        "family_back_iou": back_checkpoint.get("family_back_iou"),
        "halo_iou": back_checkpoint.get("halo_iou"),
        "ownership_mode": back_checkpoint.get("ownership_mode", "legacy"),
        "data_fingerprint": back_checkpoint.get("data_fingerprint"),
        "args": {
            "matte_checkpoint": os.path.abspath(args.matte_ckpt),
            "back_checkpoint": os.path.abspath(args.back_ckpt),
            "init": (back_checkpoint.get("args") or {}).get("init"),
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    torch.save(payload, args.out)
    print(f"[ok] {args.out} - exact baseline matte + corrected back decoder")


if __name__ == "__main__":
    main()
