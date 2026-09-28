"""Sparse learned corrections for final full/front/back layer masks."""

from __future__ import annotations

import torch
import torch.nn as nn

from vto.ownership_refiner import Down, Up
from vto.refiner import Block


NO_CHANGE = 0
TO_BACKGROUND = 1
TO_FRONT = 2
TO_BACK = 3


class LayerRefiner(nn.Module):
    """Predict a sparse transition from the production layer partition.

    Output channel zero is an explicit no-change class.  The remaining
    channels assign a pixel to background, front, or back.  This represents
    matte cleanup and ownership correction in one mutually-exclusive action,
    so a correction can never create overlap or a back pixel outside full.
    """

    architecture = "layer_refiner_v1"

    def __init__(self, no_change_logit=4.0, action_logit=-4.0):
        super().__init__()
        self.no_change_logit = float(no_change_logit)
        self.action_logit = float(action_logit)
        self.stem = Block(7, 16)
        self.down1 = Down(16, 24)
        self.down2 = Down(24, 32)
        self.down3 = Down(32, 48)
        self.down4 = Down(48, 64)
        self.down5 = Down(64, 96)
        self.mid = Block(96, 96)
        self.up4 = Up(96, 64, 64)
        self.up3 = Up(64, 48, 48)
        self.up2 = Up(48, 32, 32)
        self.up1 = Up(32, 24, 24)
        self.up0 = Up(24, 16, 16)
        self.head = nn.Conv2d(16, 4, 1)
        nn.init.zeros_(self.head.weight)
        with torch.no_grad():
            self.head.bias.fill_(self.action_logit)
            self.head.bias[NO_CHANGE] = self.no_change_logit

    @staticmethod
    def coordinates(reference):
        batch, _, height, width = reference.shape
        yy = torch.linspace(-1.0, 1.0, height, dtype=reference.dtype,
                            device=reference.device)
        xx = torch.linspace(-1.0, 1.0, width, dtype=reference.dtype,
                            device=reference.device)
        y = yy.view(1, 1, height, 1).expand(batch, 1, height, width)
        x = xx.view(1, 1, 1, width).expand(batch, 1, height, width)
        return x, y

    def forward(self, rgb, full, back):
        full_solid = (full > 0.5).to(rgb.dtype)
        back_solid = (back > 0.5).to(rgb.dtype) * full_solid
        x_coord, y_coord = self.coordinates(full_solid)
        prepared = torch.cat((rgb, x_coord, y_coord), dim=1)
        return self.forward_prepared(prepared, full_solid, back_solid)

    def forward_prepared(self, prepared, full, back):
        full_solid = (full > 0.5).to(prepared.dtype)
        back_solid = (back > 0.5).to(prepared.dtype) * full_solid
        s0 = self.stem(torch.cat((prepared, full_solid, back_solid), dim=1))
        s1 = self.down1(s0)
        s2 = self.down2(s1)
        s3 = self.down3(s2)
        s4 = self.down4(s3)
        x = self.mid(self.down5(s4))
        x = self.up4(x, s4)
        x = self.up3(x, s3)
        x = self.up2(x, s2)
        x = self.up1(x, s1)
        return self.head(self.up0(x, s0))


def transition_targets(base_full, base_back, target_full, target_back):
    """Return mutually-exclusive target classes for a layer transition."""
    base_full = base_full > 0.5
    base_back = (base_back > 0.5) & base_full
    target_full = target_full > 0.5
    target_back = (target_back > 0.5) & target_full
    base_state = torch.where(
        ~base_full, torch.zeros_like(base_full, dtype=torch.long),
        torch.where(base_back, torch.full_like(base_full, TO_BACK,
                                                dtype=torch.long),
                    torch.full_like(base_full, TO_FRONT, dtype=torch.long)))
    target_state = torch.where(
        ~target_full, torch.zeros_like(target_full, dtype=torch.long),
        torch.where(target_back, torch.full_like(target_full, TO_BACK,
                                                  dtype=torch.long),
                    torch.full_like(target_full, TO_FRONT, dtype=torch.long)))
    changed = target_state != base_state
    labels = target_state.clone()
    labels[changed & (target_state == 0)] = TO_BACKGROUND
    labels[~changed] = NO_CHANGE
    return labels


def apply_layer_actions(full, back, logits, threshold=0.5):
    """Apply confident layer transitions and return full, back, and actions."""
    probabilities = logits.softmax(dim=1)
    confidence, actions = probabilities.max(dim=1)
    actions = actions.clone()
    if isinstance(threshold, (tuple, list)):
        if len(threshold) != 3:
            raise ValueError("class thresholds must be background, front, back")
        values = logits.new_tensor((0.0, *map(float, threshold)))
        required = values[actions]
        actions[(actions != NO_CHANGE) & (confidence < required)] = NO_CHANGE
    else:
        actions[(actions != NO_CHANGE) &
                (confidence < float(threshold))] = NO_CHANGE
    full_result, back_result = apply_action_map(full, back, actions)
    return full_result, back_result, actions


def apply_action_map(full, back, actions):
    """Apply an already thresholded ``B×H×W`` transition map."""
    full_result = full > 0.5
    back_result = (back > 0.5) & full_result
    background = (actions == TO_BACKGROUND).unsqueeze(1)
    front = (actions == TO_FRONT).unsqueeze(1)
    rear = (actions == TO_BACK).unsqueeze(1)
    full_result = (full_result & ~background) | front | rear
    back_result = ((back_result & ~background & ~front) | rear) & full_result
    return full_result, back_result
