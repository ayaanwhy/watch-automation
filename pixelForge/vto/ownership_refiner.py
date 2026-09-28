"""Sparse learned corrections for final front/back ownership masks."""

import torch
import torch.nn as nn
import torch.nn.functional as F

from vto.refiner import Block


class Down(nn.Module):
    def __init__(self, cin, cout):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(cin, cout, 3, stride=2, padding=1, bias=False),
            nn.BatchNorm2d(cout), nn.ReLU(inplace=True), Block(cout, cout))

    def forward(self, x):
        return self.net(x)


class Up(nn.Module):
    def __init__(self, cin, skip, cout):
        super().__init__()
        self.block = Block(cin + skip, cout)

    def forward(self, x, skip):
        # Inputs are fixed square powers of two. A constant scale factor keeps
        # ONNX Resize entirely on CUDA; deriving `size` from the skip tensor
        # creates shape-management nodes that ORT deliberately assigns to CPU.
        x = F.interpolate(x, scale_factor=2.0, mode="bilinear",
                          align_corners=False)
        return self.block(torch.cat((x, skip), dim=1))


class OwnershipRefiner(nn.Module):
    """Detect sparse remove/add edits while defaulting to no change.

    Channel 0 means remove a pixel from the existing back layer and channel 1
    means add it.  The final head starts with zero weights and a strongly
    negative bias, so an untrained model requests no edits at the 0.5 action
    threshold.  Five encoder scales and normalized coordinates give the model
    whole-ring geometry; front/back ownership cannot be inferred reliably from
    a small local patch alone.
    """

    architecture = "ownership_refiner_v2"

    def __init__(self, no_edit_logit=-6.0):
        super().__init__()
        self.no_edit_logit = float(no_edit_logit)
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
        self.head = nn.Conv2d(16, 2, 1)
        nn.init.zeros_(self.head.weight)
        nn.init.constant_(self.head.bias, self.no_edit_logit)

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
        """ONNX-friendly path with RGBXY coordinates supplied as input."""
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


def apply_actions(base, action_logits, threshold=0.5):
    """Apply mutually-exclusive sparse actions to a binary base tensor."""
    probabilities = action_logits.sigmoid()
    remove = ((probabilities[:, :1] > threshold) &
              (probabilities[:, :1] > probabilities[:, 1:2]))
    add = ((probabilities[:, 1:2] > threshold) &
           (probabilities[:, 1:2] > probabilities[:, :1]))
    result = base > 0.5
    return (result & ~remove) | add
