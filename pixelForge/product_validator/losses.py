"""Losses that safely ignore individual unknown labels."""

from __future__ import annotations

import torch
import torch.nn.functional as F


def masked_cross_entropy(logits, target, weight=None):
    known = target >= 0
    if not torch.any(known):
        return logits.sum() * 0.0
    return F.cross_entropy(logits[known], target[known], weight=weight)


def masked_binary_cross_entropy(logits, target, pos_weight=None):
    logits = logits.squeeze(-1) if logits.ndim > target.ndim else logits
    known = target >= 0
    if not torch.any(known):
        return logits.sum() * 0.0
    safe_target = torch.where(known, target, torch.zeros_like(target))
    element_loss = F.binary_cross_entropy_with_logits(
        logits, safe_target, pos_weight=pos_weight, reduction="none")
    return element_loss[known].mean()


def multitask_loss(outputs, batch, *, asset_weight=None, view_weight=None,
                   rotation_weight=None, quality_pos_weight=None,
                   task_weights=None):
    task_weights = task_weights or {
        "asset": 1.0, "view": 1.0, "rotation": 0.75,
        "suitable": 1.0, "quality": 0.5}
    asset, view, rotation, suitable, quality = outputs
    losses = {
        "asset": masked_cross_entropy(asset, batch["asset"], asset_weight),
        "view": masked_cross_entropy(view, batch["view"], view_weight),
        "rotation": masked_cross_entropy(
            rotation, batch["rotation"], rotation_weight),
        "suitable": masked_binary_cross_entropy(
            suitable, batch["suitable"]),
        "quality": masked_binary_cross_entropy(
            quality, batch["quality"], quality_pos_weight),
    }
    total = sum(losses[name] * float(task_weights[name]) for name in losses)
    return total, losses
