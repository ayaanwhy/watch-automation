"""Standalone low-latency multi-head product validator."""

from __future__ import annotations

import torch
import torch.nn as nn
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

from .taxonomy import (ASSET_CLASSES, QUALITY_FLAGS, ROTATION_CLASSES,
                       VIEW_CLASSES)


ARCHITECTURE = "mobilenet_v3_small_multitask_v2"


class ProductValidator(nn.Module):
    def __init__(self, pretrained=True, dropout=0.20):
        super().__init__()
        weights = (MobileNet_V3_Small_Weights.IMAGENET1K_V1
                   if pretrained else None)
        base = mobilenet_v3_small(weights=weights)
        features = base.classifier[0].in_features
        self.features = base.features
        self.avgpool = base.avgpool
        self.shared = nn.Sequential(
            nn.Linear(features, 512),
            nn.Hardswish(),
            nn.Dropout(p=float(dropout)),
        )
        self.asset_head = nn.Linear(512, len(ASSET_CLASSES))
        self.view_head = nn.Linear(512, len(VIEW_CLASSES))
        self.rotation_head = nn.Linear(512, len(ROTATION_CLASSES))
        self.suitable_head = nn.Linear(512, 1)
        self.quality_head = nn.Linear(512, len(QUALITY_FLAGS))

    def forward(self, image):
        encoded = self.features(image)
        encoded = self.avgpool(encoded).flatten(1)
        shared = self.shared(encoded)
        return (
            self.asset_head(shared),
            self.view_head(shared),
            self.rotation_head(shared),
            self.suitable_head(shared),
            self.quality_head(shared),
        )


def model_from_checkpoint(checkpoint: dict) -> ProductValidator:
    if checkpoint.get("architecture") != ARCHITECTURE:
        raise ValueError("unsupported validator checkpoint architecture")
    model = ProductValidator(pretrained=False,
                             dropout=float(checkpoint.get("dropout", 0.20)))
    model.load_state_dict(checkpoint["model"])
    return model
