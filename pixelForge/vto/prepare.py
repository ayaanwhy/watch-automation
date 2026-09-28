"""Cache pairs as small crops so training is not bottlenecked on PNG decode.

Source assets are 2000px RGBA; decoding two of them per sample dominates step
time. This writes one 512px crop per pair (RGB+alpha, plus the back mask) with
a generous margin so random cropping still has room at train time.

    python -m vto.prepare --data data/pairs --out data/cache --size 512
"""

import argparse
import json
import os

import cv2
import numpy as np

from vto.data import audit, find_pairs, load_pair


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", default="data/pairs")
    p.add_argument("--out", default="data/cache")
    p.add_argument("--size", type=int, default=512)
    p.add_argument("--margin", type=float, default=0.22)
    return p.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    pairs, _ = audit(find_pairs(args.data))
    print(f"[i] caching {len(pairs)} pairs at {args.size}px")

    written = 0
    for i, (f, g) in enumerate(pairs, 1):
        r = load_pair(f, g)
        if r is None:
            continue
        rgb, fa, back = r
        ys, xs = np.nonzero(fa > 0.5)
        h, w = fa.shape
        pad = int(args.margin * max(ys.ptp() + 1, xs.ptp() + 1))
        y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, h)
        x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, w)
        rgb, fa, back = rgb[y0:y1, x0:x1], fa[y0:y1, x0:x1], back[y0:y1, x0:x1]

        s = args.size / max(rgb.shape[:2])
        if s < 1:
            wh = (int(round(rgb.shape[1] * s)), int(round(rgb.shape[0] * s)))
            rgb = cv2.resize(rgb, wh, interpolation=cv2.INTER_AREA)
            fa = cv2.resize(fa, wh, interpolation=cv2.INTER_AREA)
            back = cv2.resize(back, wh, interpolation=cv2.INTER_NEAREST)
        back *= fa > 0.5

        name = os.path.basename(os.path.dirname(f))
        d = os.path.join(args.out, name)
        os.makedirs(d, exist_ok=True)
        cv2.imwrite(os.path.join(d, "img.png"),
                    np.dstack([rgb, (fa * 255).astype(np.uint8)]))
        cv2.imwrite(os.path.join(d, "back.png"), (back * 255).astype(np.uint8))
        design_id = name.rsplit("_", 1)[0]
        family = "plain" if name.startswith(("UN", "NV")) else "mixed"
        with open(os.path.join(d, "meta.json"), "w") as f:
            json.dump({"has_back": True, "real_background": False,
                       "design_id": design_id, "family": family,
                       "source": "api_pair"}, f, indent=2)
        written += 1
        if i % 200 == 0:
            print(f"    {i}/{len(pairs)}", flush=True)
    print(f"[✓] {written} cached -> {args.out}")


if __name__ == "__main__":
    main()
