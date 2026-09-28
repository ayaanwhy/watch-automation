"""Shared inference and metric collection for validator experiments."""

from __future__ import annotations

import random

import numpy as np
import torch

from .metrics import binary_report, classification_report, quality_report
from .taxonomy import (ASSET_CLASSES, QUALITY_FLAGS, ROTATION_CLASSES,
                       VIEW_CLASSES)


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def move_targets(batch: dict, device: torch.device) -> dict:
    return {
        key: value.to(device, non_blocking=True)
        for key, value in batch.items()
        if key in {"asset", "view", "rotation", "suitable", "quality"}
    }


@torch.inference_mode()
def collect_predictions(model, loader, device: torch.device) -> dict:
    model.eval()
    collected = {
        "asset_target": [], "view_target": [], "rotation_target": [],
        "suitable_target": [],
        "quality_target": [], "asset_probability": [],
        "view_probability": [], "rotation_probability": [],
        "suitable_probability": [],
        "quality_probability": [], "ids": [],
    }
    for batch in loader:
        outputs = model(batch["image"].to(device, non_blocking=True))
        asset, view, rotation, suitable, quality = outputs
        collected["asset_probability"].append(
            torch.softmax(asset, dim=1).cpu().numpy())
        collected["view_probability"].append(
            torch.softmax(view, dim=1).cpu().numpy())
        collected["rotation_probability"].append(
            torch.softmax(rotation, dim=1).cpu().numpy())
        collected["suitable_probability"].append(
            torch.sigmoid(suitable.squeeze(1)).cpu().numpy())
        collected["quality_probability"].append(
            torch.sigmoid(quality).cpu().numpy())
        for name in ("asset", "view", "rotation", "suitable", "quality"):
            collected[f"{name}_target"].append(batch[name].cpu().numpy())
        collected["ids"].extend(batch["id"])
    if not collected["ids"]:
        raise ValueError("evaluation dataset is empty")
    for key in tuple(collected):
        if key != "ids":
            collected[key] = np.concatenate(collected[key], axis=0)
    return collected


def metric_summary(predictions: dict) -> dict:
    return {
        "asset": classification_report(
            predictions["asset_target"],
            predictions["asset_probability"], ASSET_CLASSES),
        "view": classification_report(
            predictions["view_target"],
            predictions["view_probability"], VIEW_CLASSES),
        "rotation": classification_report(
            predictions["rotation_target"],
            predictions["rotation_probability"], ROTATION_CLASSES),
        "suitable": binary_report(
            predictions["suitable_target"],
            predictions["suitable_probability"]),
        "quality": quality_report(
            predictions["quality_target"],
            predictions["quality_probability"], QUALITY_FLAGS),
    }


def selection_score(summary: dict) -> float:
    values = []
    for task in ("asset", "view", "rotation"):
        value = summary[task].get("macro_f1")
        if value is not None:
            values.append(float(value))
    suitable = summary["suitable"].get("accuracy")
    if suitable is not None:
        values.append(float(suitable))
    quality = [row["accuracy"] for row in summary["quality"].values()
               if row["accuracy"] is not None]
    if quality:
        values.append(float(np.mean(quality)))
    return float(np.mean(values)) if values else float("-inf")
