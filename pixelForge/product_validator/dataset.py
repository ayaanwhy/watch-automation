"""Manifest-backed, partial-label dataset with group-safe splitting."""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import torch
from PIL import Image, ImageOps
from torch.utils.data import Dataset
from torchvision import transforms
from torchvision.transforms import InterpolationMode

from .manifest import load_manifest, resolve_image
from .taxonomy import (ASSET_CLASSES, QUALITY_FLAGS, ROTATION_CLASSES,
                       VIEW_CLASSES)


IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


class Letterbox:
    def __init__(self, size: int, fill=(247, 247, 247)):
        self.size = int(size)
        self.fill = tuple(fill)

    def __call__(self, image: Image.Image) -> Image.Image:
        image = image.copy()
        image.thumbnail((self.size, self.size), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (self.size, self.size), self.fill)
        x = (self.size - image.width) // 2
        y = (self.size - image.height) // 2
        canvas.paste(image, (x, y))
        return canvas


def image_transform(size=224, train=False):
    operations = [Letterbox(size)]
    if train:
        operations.extend([
            transforms.RandomAffine(
                # Positive catalogue renders are often tight to the canvas.
                # Keep augmentation inside the frame so we never teach an
                # accidentally cropped image with a clean-quality label.
                degrees=3, translate=(0.02, 0.02), scale=(0.82, 0.94),
                interpolation=InterpolationMode.BILINEAR,
                fill=(247, 247, 247)),
            transforms.ColorJitter(
                brightness=0.12, contrast=0.12, saturation=0.08, hue=0.02),
        ])
    operations.extend([
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])
    return transforms.Compose(operations)


def manifest_fingerprint(manifest: dict) -> str:
    stable = [{key: case.get(key) for key in
               ("id", "sha256", "group_id", "labels")}
              for case in manifest["cases"]]
    payload = json.dumps(stable, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _tokens(case: dict) -> set[str]:
    labels = case["labels"]
    tokens = set()
    for field in ("asset", "view", "rotation"):
        if labels.get(field) is not None:
            tokens.add(f"{field}:{labels[field]}")
    if labels.get("suitable") is not None:
        tokens.add(f"suitable:{str(labels['suitable']).lower()}")
    if labels.get("quality") is not None:
        tokens.add("quality:known")
        tokens.update(f"quality:{flag}" for flag in labels["quality"])
    return tokens


def _rank(seed: int, group_id: str) -> str:
    return hashlib.sha256(f"{seed}:{group_id}".encode()).hexdigest()


def split_groups(cases: list[dict], val_fraction=0.20, seed=2026):
    """Keep products together and every observed label in training.

    Validation coverage and fraction are best-effort: a singleton label stays
    in training, and an impossible nonempty split raises instead of dropping it.
    """
    if not 0.0 < val_fraction < 1.0:
        raise ValueError("val_fraction must be between 0 and 1")
    groups = defaultdict(list)
    for case in cases:
        groups[case["group_id"]].append(case)
    group_ids = sorted(groups, key=lambda value: _rank(seed, value))
    if len(group_ids) < 2:
        raise ValueError("at least two product groups are required")

    target = max(1, min(len(group_ids) - 1,
                        int(round(len(group_ids) * val_fraction))))
    group_tokens = {
        group_id: set().union(*(_tokens(case) for case in group_cases))
        for group_id, group_cases in groups.items()
    }
    token_groups = defaultdict(set)
    for group_id, tokens in group_tokens.items():
        for token in tokens:
            token_groups[token].add(group_id)
    required = {token for token, members in token_groups.items()
                if len(members) >= 2}

    selected = set()

    def can_hold_out(group_id):
        proposed = selected | {group_id}
        return (len(proposed) < len(groups) and
                not any(token_groups[token] <= proposed
                        for token in group_tokens[group_id]))

    uncovered = set(required)
    while uncovered:
        candidates = []
        for group_id in group_ids:
            if group_id in selected:
                continue
            # At least one group for every represented token must remain in
            # training. This is more important than hitting an exact fraction.
            if not can_hold_out(group_id):
                continue
            gain = len(group_tokens[group_id] & uncovered)
            if gain:
                candidates.append((-gain, _rank(seed, group_id), group_id))
        if not candidates:
            break
        _, _, chosen = min(candidates)
        selected.add(chosen)
        uncovered -= group_tokens[chosen]

    for group_id in group_ids:
        if len(selected) >= target:
            break
        if group_id not in selected and can_hold_out(group_id):
            selected.add(group_id)
    if not selected:
        raise ValueError(
            "cannot create nonempty validation while retaining every label in "
            "training; collect more independent product groups")

    train = [case for group_id, members in groups.items()
             if group_id not in selected for case in members]
    val = [case for group_id, members in groups.items()
           if group_id in selected for case in members]
    return train, val, selected


def label_index(value, classes):
    return -1 if value is None else classes.index(value)


def synthetic_rotation(image: Image.Image, correction: str) -> Image.Image:
    """Rotate a canonical image opposite to its required correction."""
    transpose = {
        "rotate_right": Image.Transpose.ROTATE_90,
        "rotate_left": Image.Transpose.ROTATE_270,
        "half_turn": Image.Transpose.ROTATE_180,
    }
    if correction not in transpose:
        raise ValueError(f"unsupported synthetic correction: {correction}")
    return image.transpose(transpose[correction])


class ValidatorDataset(Dataset):
    def __init__(self, manifest_path: str | Path, cases: list[dict],
                 size=224, train=False):
        self.manifest_path = Path(manifest_path).resolve()
        self.manifest = load_manifest(self.manifest_path)
        self.cases = list(cases)
        self.train = bool(train)
        self.transform = image_transform(size=size, train=train)

    def __len__(self):
        return len(self.cases)

    def __getitem__(self, index):
        case = self.cases[index]
        path = resolve_image(self.manifest_path, self.manifest, case)
        with Image.open(path) as opened:
            opened = ImageOps.exif_transpose(opened)
            if opened.mode in ("RGBA", "LA") or "transparency" in opened.info:
                rgba = opened.convert("RGBA")
                ground = Image.new("RGBA", rgba.size, (247, 247, 247, 255))
                image = Image.alpha_composite(ground, rgba).convert("RGB")
            else:
                image = opened.convert("RGB")
        labels = case["labels"]
        rotation = labels.get("rotation")
        can_rotate = (
            self.train and labels.get("asset") in ("ring", "gemstone") and
            labels.get("view") == "front" and rotation == "none" and
            labels.get("suitable") is True and labels.get("quality") == [])
        if can_rotate and bool(torch.rand(()) < 0.30):
            rotation = ROTATION_CLASSES[1 + int(torch.randint(0, 3, ()))]
            image = synthetic_rotation(image, rotation)
        tensor = self.transform(image)

        quality = labels.get("quality")
        quality_target = ([-1.0] * len(QUALITY_FLAGS) if quality is None else
                          [float(flag in quality) for flag in QUALITY_FLAGS])
        suitable = labels.get("suitable")
        return {
            "image": tensor,
            "asset": torch.tensor(
                label_index(labels.get("asset"), ASSET_CLASSES),
                dtype=torch.long),
            "view": torch.tensor(
                label_index(labels.get("view"), VIEW_CLASSES),
                dtype=torch.long),
            "rotation": torch.tensor(
                label_index(rotation, ROTATION_CLASSES), dtype=torch.long),
            "suitable": torch.tensor(
                -1.0 if suitable is None else float(suitable),
                dtype=torch.float32),
            "quality": torch.tensor(quality_target, dtype=torch.float32),
            "id": case["id"],
            "group_id": case["group_id"],
        }


def class_weights(cases: list[dict], field: str, classes: tuple[str, ...]):
    counts = Counter(case["labels"].get(field) for case in cases)
    values = [counts[name] for name in classes]
    if any(value == 0 for value in values):
        return None
    total = float(sum(values))
    weights = [math.sqrt(total / (len(values) * value)) for value in values]
    return torch.tensor(weights, dtype=torch.float32)
