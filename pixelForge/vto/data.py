"""Pair loading and augmentation for ring front/back segmentation.

A training example is a (full, front) pair the retouchers already produced.
The supervision signal is derived, not annotated:

    full_alpha  = alpha of full.png          -> matte target
    back        = full_alpha AND NOT front   -> layer target

The model takes RGB only, so it runs on raw catalogue JPEGs that carry no
alpha; both targets are predicted.
"""

import glob
import json
import os

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset


def align_shift(full_mask, front_mask):
    """Offset that best places `front` inside `full`.

    Retouchers sometimes trim the canvas (one observed pair differed by 67px),
    so pairs cannot be assumed pixel-aligned. Cross-correlation via FFT finds
    the shift cheaply even at 2000px.
    """
    h = max(full_mask.shape[0], front_mask.shape[0])
    w = max(full_mask.shape[1], front_mask.shape[1])
    a = np.zeros((h, w), np.float32); b = np.zeros((h, w), np.float32)
    a[:full_mask.shape[0], :full_mask.shape[1]] = full_mask
    b[:front_mask.shape[0], :front_mask.shape[1]] = front_mask
    corr = np.fft.irfft2(np.fft.rfft2(a) * np.conj(np.fft.rfft2(b)), s=(h, w))
    dy, dx = np.unravel_index(int(np.argmax(corr)), corr.shape)
    if dy > h // 2: dy -= h
    if dx > w // 2: dx -= w
    return int(dy), int(dx)


def place(img, shape, dy, dx):
    """Paste `img` into a canvas of `shape` at (dy, dx)."""
    out = np.zeros(shape + img.shape[2:], img.dtype)
    y0, x0 = max(dy, 0), max(dx, 0)
    y1 = min(shape[0], dy + img.shape[0]); x1 = min(shape[1], dx + img.shape[1])
    if y1 <= y0 or x1 <= x0:
        return out
    out[y0:y1, x0:x1] = img[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    return out


def load_pair(full_path, front_path, min_coverage=0.97, max_back_frac=0.6):
    """Return (rgb, full_alpha, back_mask), or None if the pair looks unusable.

    `front` must be close to a subset of `full` once aligned - that is the whole
    premise of the label. A pair that fails containment is a mismatched or
    re-rendered variant rather than a clean cut, and training on it teaches the
    wrong thing.
    """
    full = cv2.imread(full_path, cv2.IMREAD_UNCHANGED)
    front = cv2.imread(front_path, cv2.IMREAD_UNCHANGED)
    if full is None or front is None:
        return None
    if full.ndim != 3 or full.shape[2] != 4 or front.ndim != 3 or front.shape[2] != 4:
        return None

    fa = full[..., 3].astype(np.float32) / 255.0
    ga = front[..., 3].astype(np.float32) / 255.0
    dy, dx = align_shift(fa > 0.5, ga > 0.5)
    ga = place(ga, fa.shape, dy, dx)

    fb, gb = fa > 0.5, ga > 0.5
    if gb.sum() < 100 or fb.sum() < 100:
        return None
    coverage = (fb & gb).sum() / gb.sum()          # front contained in full?
    back = (fb & ~gb).astype(np.float32)
    frac = back.sum() / fb.sum()
    if coverage < min_coverage or not (0.01 <= frac <= max_back_frac):
        return None
    return full[..., :3], fa, back


def audit(pairs, verbose=False):
    """Keep only pairs that survive load_pair's checks."""
    good, bad = [], []
    for f, g in pairs:
        try:
            ok = load_pair(f, g) is not None
        except Exception:
            ok = False
        (good if ok else bad).append((f, g))
        if verbose and not ok:
            print(f"    reject {os.path.basename(os.path.dirname(f))}")
    return good, bad


def find_pairs(root):
    """Directories holding full.png + front.png, or *_full/_front file pairs."""
    pairs = []
    for d in sorted(glob.glob(os.path.join(root, "*"))):
        f, g = os.path.join(d, "full.png"), os.path.join(d, "front.png")
        if os.path.isfile(f) and os.path.isfile(g):
            pairs.append((f, g))
    for f in sorted(glob.glob(os.path.join(root, "*_full.png"))):
        g = f.replace("_full.png", "_front.png")
        if os.path.isfile(g):
            pairs.append((f, g))
    return pairs


def random_background(h, w, rng):
    """Backgrounds vary across merchants; train the matte to not care."""
    kind = rng.integers(0, 4)
    if kind == 0:                                   # near-white, the common case
        base = rng.integers(238, 256)
        bg = np.full((h, w, 3), base, np.float32)
    elif kind == 1:                                 # flat colour
        bg = np.full((h, w, 3), rng.integers(0, 256, 3).astype(np.float32), np.float32)
    elif kind == 2:                                 # vertical gradient
        top = rng.integers(0, 256, 3).astype(np.float32)
        bot = rng.integers(0, 256, 3).astype(np.float32)
        ramp = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
        bg = top[None, None] * (1 - ramp) + bot[None, None] * ramp
        bg = np.repeat(bg, w, axis=1)
    else:                                           # low-frequency noise
        small = rng.integers(0, 256, (8, 8, 3)).astype(np.float32)
        bg = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    return np.clip(bg + rng.normal(0, 2, (h, w, 3)), 0, 255).astype(np.float32)


class RingPairs(Dataset):
    def __init__(self, pairs, size=384, train=True, seed=0):
        self.pairs = pairs
        self.size = size
        self.train = train
        self.seed = int(seed)

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, i):
        rgb, fa, back = load_pair(*self.pairs[i])
        rng_seed = ((torch.initial_seed() if self.train else self.seed)
                    + 0x9E3779B1 * (i + 1)) % (2 ** 63 - 1)
        rng = np.random.default_rng(rng_seed)
        s = self.size

        # crop to the item with margin, keeping targets in step
        ys, xs = np.nonzero(fa > 0.5)
        pad = int(0.10 * max(ys.ptp() + 1, xs.ptp() + 1))
        if self.train:
            pad = int(pad * rng.uniform(0.5, 2.0))
        y0 = max(ys.min() - pad, 0); y1 = min(ys.max() + pad, fa.shape[0])
        x0 = max(xs.min() - pad, 0); x1 = min(xs.max() + pad, fa.shape[1])
        rgb, fa, back = rgb[y0:y1, x0:x1], fa[y0:y1, x0:x1], back[y0:y1, x0:x1]

        if self.train:
            ang = rng.uniform(-12, 12)
            sc = rng.uniform(0.85, 1.15)
            h, w = fa.shape
            M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, sc)
            rgb = cv2.warpAffine(rgb, M, (w, h), flags=cv2.INTER_LINEAR)
            fa = cv2.warpAffine(fa, M, (w, h), flags=cv2.INTER_LINEAR)
            back = cv2.warpAffine(back, M, (w, h), flags=cv2.INTER_NEAREST)
            if rng.random() < 0.5:
                rgb, fa, back = rgb[:, ::-1], fa[:, ::-1], back[:, ::-1]

        rgb = cv2.resize(rgb, (s, s), interpolation=cv2.INTER_AREA).astype(np.float32)
        fa = cv2.resize(fa, (s, s), interpolation=cv2.INTER_AREA)
        back = cv2.resize(back, (s, s), interpolation=cv2.INTER_NEAREST)
        back *= fa > 0.5

        bg = random_background(s, s, rng) if self.train else np.full((s, s, 3), 247.0, np.float32)
        a3 = fa[..., None]
        comp = rgb * a3 + bg * (1 - a3)

        if self.train:
            comp *= rng.uniform(0.9, 1.1)
            comp += rng.uniform(-8, 8)
        comp = np.clip(comp, 0, 255) / 255.0

        x = torch.from_numpy(np.ascontiguousarray(comp.transpose(2, 0, 1)))
        y = torch.from_numpy(np.ascontiguousarray(
            np.stack([fa, back])).astype(np.float32))
        return x, y, torch.ones(2, dtype=torch.float32)


def find_cached(root):
    """Cached crops written by vto.prepare / vto.ingest.

    Each entry is (img, back, has_back). `has_back` is False for loose
    gemstones, which have a matte but no front/back split; their back channel
    is excluded from the loss rather than trained towards an empty mask.
    """
    out = []
    for d in sorted(glob.glob(os.path.join(root, "*"))):
        i, b = os.path.join(d, "img.png"), os.path.join(d, "back.png")
        if not (os.path.isfile(i) and os.path.isfile(b)):
            continue
        has_back = True
        m = os.path.join(d, "meta.json")
        if os.path.isfile(m):
            try:
                has_back = bool(json.load(open(m)).get("has_back", True))
            except Exception:
                pass
        out.append((i, b, has_back))
    return out


def cached_meta(item):
    """Metadata attached to one cached sample, if present."""
    path = os.path.join(os.path.dirname(item[0]), "meta.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return {}


def cached_name(item):
    return os.path.basename(os.path.dirname(item[0]))


def design_of(item):
    """Stable physical-design key used to prevent split leakage.

    Newly ingested data carries an explicit ``design_id``.  Legacy API cache
    entries use ``<product sku>_<variant id>``, so dropping the final suffix
    keeps metal/stone variants of one setting together.
    """
    meta = cached_meta(item)
    if meta.get("design_id"):
        return str(meta["design_id"])
    name = cached_name(item)
    if name.startswith("gem_"):
        return name
    return name.rsplit("_", 1)[0]


def family_of(item):
    """Coarse family used for stratified validation and sampling."""
    meta = cached_meta(item)
    if meta.get("family"):
        return str(meta["family"])
    name = cached_name(item)
    if name.startswith(("gem_", "gemmulti_")):
        return "gem"
    if name.startswith("6BGN"):
        return "halo"
    if name.startswith(("UN", "NV")):
        return "plain"
    return "mixed"


class CachedPairs(Dataset):
    """Same targets as RingPairs, reading vto.prepare / vto.ingest crops."""

    def __init__(self, items, size=384, train=True, seed=0,
                 return_pixel_weight=False):
        self.items = items
        self.size = size
        self.train = train
        self.seed = int(seed)
        self.return_pixel_weight = bool(return_pixel_weight)
        # entries ingested with a real photographic background keep it; the
        # rest are cut-outs and get recomposited onto a synthetic ground.
        self.real_bg = []
        for it in items:
            m = os.path.join(os.path.dirname(it[0]), "meta.json")
            r = False
            if os.path.isfile(m):
                try:
                    r = bool(json.load(open(m)).get("real_background", False))
                except Exception:
                    r = False
            self.real_bg.append(r)

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        item = self.items[i]
        has_back = item[2] if len(item) > 2 else True
        img = cv2.imread(item[0], cv2.IMREAD_UNCHANGED)
        back = cv2.imread(item[1], cv2.IMREAD_GRAYSCALE)
        pixel_weight = None
        if self.return_pixel_weight:
            directory = os.path.dirname(item[0])
            edit_paths = [os.path.join(directory, name) for name in
                          ("matte_edit.png", "back_edit.png")]
            present = [os.path.isfile(path) for path in edit_paths]
            if any(present) and not all(present):
                raise ValueError(f"incomplete sparse edit masks under {directory}")
            if all(present):
                edits = [cv2.imread(path, cv2.IMREAD_GRAYSCALE)
                         for path in edit_paths]
                if any(edit is None for edit in edits):
                    raise ValueError(f"unreadable sparse edit masks under {directory}")
                pixel_weight = np.stack(
                    [(edit > 127).astype(np.float32) for edit in edits])
        rgb = img[..., :3].astype(np.float32)
        fa = img[..., 3].astype(np.float32) / 255.0
        back = (back > 127).astype(np.float32)
        # A mutable Generator stored on the Dataset is cloned into every
        # DataLoader worker, making workers repeat the same augmentations.  A
        # worker/epoch seed from torch plus the item id gives independent,
        # reproducible draws instead.
        rng_seed = ((torch.initial_seed() if self.train else self.seed)
                    + 0x9E3779B1 * (i + 1)) % (2 ** 63 - 1)
        rng = np.random.default_rng(rng_seed)
        s = self.size

        if self.train:
            ang = rng.uniform(-12, 12)
            sc = rng.uniform(0.85, 1.20)
            h, w = fa.shape
            M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, sc)
            M[0, 2] += rng.uniform(-0.03, 0.03) * w
            M[1, 2] += rng.uniform(-0.03, 0.03) * h
            rgb = cv2.warpAffine(rgb, M, (w, h), flags=cv2.INTER_LINEAR)
            fa = cv2.warpAffine(fa, M, (w, h), flags=cv2.INTER_LINEAR)
            back = cv2.warpAffine(back, M, (w, h), flags=cv2.INTER_NEAREST)
            if pixel_weight is not None:
                pixel_weight = np.stack([
                    cv2.warpAffine(channel, M, (w, h),
                                   flags=cv2.INTER_NEAREST)
                    for channel in pixel_weight])
            if rng.random() < 0.5:
                rgb, fa, back = rgb[:, ::-1], fa[:, ::-1], back[:, ::-1]
                if pixel_weight is not None:
                    pixel_weight = pixel_weight[:, :, ::-1]

        rgb = cv2.resize(rgb, (s, s), interpolation=cv2.INTER_AREA)
        fa = cv2.resize(fa, (s, s), interpolation=cv2.INTER_AREA)
        back = cv2.resize(back, (s, s), interpolation=cv2.INTER_NEAREST)
        if pixel_weight is not None:
            pixel_weight = np.stack([
                cv2.resize(channel, (s, s), interpolation=cv2.INTER_NEAREST)
                for channel in pixel_weight])
        # Nearest-neighbour resizing can move a one-pixel back edge just beyond
        # the antialiased matte.  Keep the two targets a strict partition.
        back *= fa > 0.5

        if self.real_bg[i]:
            comp = rgb                      # already a real photograph
        else:
            bg = (random_background(s, s, rng) if self.train
                  else np.full((s, s, 3), 247.0, np.float32))
            a3 = fa[..., None]
            comp = rgb * a3 + bg * (1 - a3)
        if self.train:
            comp = comp * rng.uniform(0.9, 1.1) + rng.uniform(-8, 8)
        comp = np.clip(comp, 0, 255) / 255.0

        x = torch.from_numpy(np.ascontiguousarray(comp.transpose(2, 0, 1)).astype(np.float32))
        y = torch.from_numpy(np.ascontiguousarray(np.stack([fa, back])).astype(np.float32))
        w = torch.tensor([1.0, 1.0 if has_back else 0.0], dtype=torch.float32)
        if not self.return_pixel_weight:
            return x, y, w
        if pixel_weight is None:
            pixel_weight = np.ones((2, s, s), np.float32)
        return x, y, w, torch.from_numpy(np.ascontiguousarray(pixel_weight))
