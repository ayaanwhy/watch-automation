"""High-resolution matte refinement around a frozen v6 silhouette.

The semantic front/back model is deliberately left untouched.  A lightweight
U-Net sees the 512px RGB crop plus v6's coarse matte and predicts a residual
only inside a narrow contour band.  The back logit is passed through exactly,
so improving white-background removal cannot move the hand-occlusion seam.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F

from vto.model import RingUNet


class Block(nn.Module):
    def __init__(self, cin, cout):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(cin, cout, 3, padding=1, bias=False),
            nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
            nn.Conv2d(cout, cout, 3, padding=1, bias=False),
            nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
        )

    def forward(self, x):
        return self.net(x)


class MatteRefiner(nn.Module):
    def __init__(self, band_radius=8):
        super().__init__()
        self.band_radius = int(band_radius)
        self.stem = Block(4, 16)
        self.down1 = nn.Sequential(nn.Conv2d(16, 24, 3, stride=2, padding=1),
                                   nn.ReLU(inplace=True), Block(24, 24))
        self.down2 = nn.Sequential(nn.Conv2d(24, 32, 3, stride=2, padding=1),
                                   nn.ReLU(inplace=True), Block(32, 32))
        self.mid = Block(32, 32)
        self.up1 = Block(32 + 24, 24)
        self.up0 = Block(24 + 16, 16)
        self.head = nn.Conv2d(16, 1, 1)
        # At initialization the hybrid is exactly the frozen base model.
        nn.init.zeros_(self.head.weight)
        nn.init.zeros_(self.head.bias)

    def contour_band(self, coarse_logit):
        solid = (coarse_logit.sigmoid() > 0.5).to(coarse_logit.dtype)
        radius = self.band_radius
        kernel = 2 * radius + 1
        dilated = F.max_pool2d(solid, kernel, stride=1, padding=radius)
        eroded = -F.max_pool2d(-solid, kernel, stride=1, padding=radius)
        return (dilated - eroded).clamp(0.0, 1.0)

    def forward(self, rgb, coarse_logit):
        s0 = self.stem(torch.cat([rgb, coarse_logit.sigmoid()], dim=1))
        s1 = self.down1(s0)
        x = self.mid(self.down2(s1))
        x = F.interpolate(x, size=s1.shape[-2:], mode="bilinear", align_corners=False)
        x = self.up1(torch.cat([x, s1], dim=1))
        x = F.interpolate(x, size=s0.shape[-2:], mode="bilinear", align_corners=False)
        residual = self.head(self.up0(torch.cat([x, s0], dim=1)))
        return coarse_logit + residual * self.contour_band(coarse_logit)


class HybridRingModel(nn.Module):
    """Frozen semantic base plus matte-only refiner, exported as one graph."""

    def __init__(self, base_model, refiner, base_size=384):
        super().__init__()
        self.base = base_model
        self.refiner = refiner
        self.base_size = int(base_size)

    def forward(self, x):
        base_x = F.interpolate(x, size=(self.base_size, self.base_size),
                               mode="bilinear", align_corners=False)
        base_logits = self.base(base_x)
        base_logits = F.interpolate(base_logits, size=x.shape[-2:],
                                    mode="bilinear", align_corners=False)
        matte = self.refiner(x, base_logits[:, :1])
        return torch.cat([matte, base_logits[:, 1:2]], dim=1)


def load_hybrid(base_checkpoint, refiner_checkpoint, device="cpu"):
    base = RingUNet(pretrained=False)
    base.load_state_dict(base_checkpoint["model"])
    base.requires_grad_(False).eval()
    refiner = MatteRefiner(refiner_checkpoint.get("band_radius", 8))
    refiner.load_state_dict(refiner_checkpoint["refiner"])
    model = HybridRingModel(base, refiner,
                            base_size=int(base_checkpoint.get("size", 384)))
    return model.to(device)
