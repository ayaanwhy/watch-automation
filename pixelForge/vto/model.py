"""ResNet18-UNet predicting the full matte and the back layer.

Two heads rather than one: the matte target comes free with the pairs, and
predicting it alongside gives the network an explicit notion of where the item
ends -- which is the cue the colour matte could not recover for white stones on
a white ground.
"""

import copy

import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision.models import ResNet18_Weights, resnet18


class Up(nn.Module):
    def __init__(self, cin, skip, cout):
        super().__init__()
        self.block = nn.Sequential(
            nn.Conv2d(cin + skip, cout, 3, padding=1, bias=False),
            nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
            nn.Conv2d(cout, cout, 3, padding=1, bias=False),
            nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
        )

    def forward(self, x, skip=None):
        x = F.interpolate(x, scale_factor=2, mode="nearest")
        if skip is not None:
            x = torch.cat([x, skip], dim=1)
        return self.block(x)


class RingUNet(nn.Module):
    def __init__(self, pretrained=True, out_channels=2):
        super().__init__()
        net = resnet18(weights=ResNet18_Weights.IMAGENET1K_V1 if pretrained else None)
        self.stem = nn.Sequential(net.conv1, net.bn1, net.relu)   # /2, 64
        self.pool = net.maxpool
        self.l1, self.l2, self.l3, self.l4 = net.layer1, net.layer2, net.layer3, net.layer4

        self.up4 = Up(512, 256, 256)
        self.up3 = Up(256, 128, 128)
        self.up2 = Up(128, 64, 64)
        self.up1 = Up(64, 64, 48)
        self.up0 = Up(48, 0, 32)
        self.head = nn.Conv2d(32, out_channels, 1)

    def forward(self, x):
        s0 = self.stem(x)          # /2
        s1 = self.l1(self.pool(s0))  # /4
        s2 = self.l2(s1)             # /8
        s3 = self.l3(s2)             # /16
        s4 = self.l4(s3)             # /32
        d = self.up4(s4, s3)
        d = self.up3(d, s2)
        d = self.up2(d, s1)
        d = self.up1(d, s0)
        d = self.up0(d)
        return self.head(d)


class DualDecoderRingUNet(nn.Module):
    """One frozen encoder with independent matte and ownership decoders.

    Ownership corrections need decoder adaptation, but changing shared decoder
    features also moves the already-approved outer silhouette.  This fused
    deployment form runs the common ResNet encoder once, then uses the proven
    baseline decoder for matte channel 0 and the corrected decoder for back
    channel 1.  It therefore preserves the baseline matte exactly without
    paying for a second encoder pass.
    """

    architecture = "dual_decoder_v1"

    def __init__(self, matte_model=None, back_model=None):
        super().__init__()
        matte_model = matte_model or RingUNet(pretrained=False)
        back_model = back_model or RingUNet(pretrained=False)

        for name in ("stem", "pool", "l1", "l2", "l3", "l4"):
            setattr(self, name, copy.deepcopy(getattr(matte_model, name)))
        for prefix, source in (("matte", matte_model), ("back", back_model)):
            for name in ("up4", "up3", "up2", "up1", "up0"):
                setattr(self, f"{prefix}_{name}", copy.deepcopy(getattr(source, name)))
            head = nn.Conv2d(32, 1, 1)
            channel = 0 if prefix == "matte" else 1
            with torch.no_grad():
                head.weight.copy_(source.head.weight[channel:channel + 1])
                if head.bias is not None:
                    head.bias.copy_(source.head.bias[channel:channel + 1])
            setattr(self, f"{prefix}_head", head)

    def _decode(self, prefix, s0, s1, s2, s3, s4):
        d = getattr(self, f"{prefix}_up4")(s4, s3)
        d = getattr(self, f"{prefix}_up3")(d, s2)
        d = getattr(self, f"{prefix}_up2")(d, s1)
        d = getattr(self, f"{prefix}_up1")(d, s0)
        d = getattr(self, f"{prefix}_up0")(d)
        return getattr(self, f"{prefix}_head")(d)

    def forward(self, x):
        s0 = self.stem(x)
        s1 = self.l1(self.pool(s0))
        s2 = self.l2(s1)
        s3 = self.l3(s2)
        s4 = self.l4(s3)
        matte = self._decode("matte", s0, s1, s2, s3, s4)
        back = self._decode("back", s0, s1, s2, s3, s4)
        return torch.cat((matte, back), dim=1)


def model_from_checkpoint(checkpoint):
    """Instantiate and load either the legacy or fused deployment model."""
    architecture = checkpoint.get("architecture", "ring_unet_v1")
    if architecture == "ring_unet_v1":
        model = RingUNet(pretrained=False)
    elif architecture == DualDecoderRingUNet.architecture:
        model = DualDecoderRingUNet()
    else:
        raise ValueError(f"unsupported model architecture: {architecture}")
    model.load_state_dict(checkpoint["model"])
    return model


def dice_per_sample(logits, target, eps=1.0):
    p = torch.sigmoid(logits)
    num = 2 * (p * target).sum(dim=(2, 3)) + eps
    den = p.sum(dim=(2, 3)) + target.sum(dim=(2, 3)) + eps
    return 1 - num / den                                   # (B, C)


def tversky_per_sample(logits, target, alpha=0.3, beta=0.7, eps=1.0):
    """Recall-biased overlap loss for the frequently under-cut back layer."""
    p = torch.sigmoid(logits)
    tp = (p * target).sum(dim=(2, 3))
    fp = (p * (1 - target)).sum(dim=(2, 3))
    fn = ((1 - p) * target).sum(dim=(2, 3))
    return 1 - (tp + eps) / (tp + alpha * fp + beta * fn + eps)


def boundary_band(target, radius=2):
    """Return a soft band on both sides of every target contour.

    Foreground/background BCE is otherwise dominated by easy pixels far away
    from the item.  A narrow band makes the small gaps between halo stones and
    the outer gemstone edge matter during fine-tuning without eroding white
    facets by colour in post-processing.
    """
    if radius <= 0:
        return torch.zeros_like(target)
    kernel = 2 * int(radius) + 1
    dilated = F.max_pool2d(target, kernel, stride=1, padding=int(radius))
    eroded = -F.max_pool2d(-target, kernel, stride=1, padding=int(radius))
    return (dilated - eroded).clamp(0.0, 1.0)


def loss_fn(logits, target, sample_weight=None, pixel_weight=None,
            back_weight=2.0, edge_weight=0.0, edge_radius=2,
            back_edge_weight=0.0):
    """BCE plus matte Dice / recall-biased back Tversky overlap losses.

    `sample_weight` is (B, 2): a loose gemstone has a matte but no front/back
    split, so its back channel is weighted 0 rather than supervised towards an
    empty mask - which would teach the model that stones never occlude.
    """
    B, C = logits.shape[:2]
    if sample_weight is None:
        sample_weight = torch.ones(B, C, device=logits.device)
    if pixel_weight is None:
        pixel_weight = torch.ones_like(target)
    if pixel_weight.shape != target.shape:
        raise ValueError("pixel_weight must have the same shape as target")
    pixel_weight = pixel_weight.to(logits.device).clamp(min=0.0)
    active = (pixel_weight.sum(dim=(2, 3)) > 0).float()
    chan = torch.tensor([1.0, back_weight], device=logits.device).view(1, C)
    w = sample_weight * chan * active                       # (B, C)

    bce_pixels = F.binary_cross_entropy_with_logits(logits, target, reduction="none")
    if edge_weight > 0 or back_edge_weight > 0:
        # Edge refinement is a matte concern.  Weighting the back channel here
        # moved the learned front/back seam on unseen rings (a real v7
        # regression), even though the request was only to improve the outer
        # silhouette.  Keep ordinary back supervision completely unchanged.
        contour_weight = torch.ones_like(target)
        if edge_weight > 0:
            contour_weight[:, :1] += (float(edge_weight) *
                                      boundary_band(target[:, :1], edge_radius))
        if back_edge_weight > 0:
            contour_weight[:, 1:2] += (
                float(back_edge_weight) *
                boundary_band(target[:, 1:2], edge_radius))
        pixel_weight = pixel_weight * contour_weight
    bce_per_sample = ((bce_pixels * pixel_weight).sum(dim=(2, 3)) /
                      pixel_weight.sum(dim=(2, 3)).clamp(min=1e-6))
    bce = (bce_per_sample * w).sum() / w.sum().clamp(min=1e-6)
    dice = dice_per_sample(logits, target)
    tversky = tversky_per_sample(logits, target)
    overlap = torch.stack([dice[:, 0], tversky[:, 1]], dim=1)
    # Dice/Tversky are global shape losses and therefore inappropriate for a
    # sparse manual edit. Apply them only to ordinary dense examples; sparse
    # correction examples receive normalized BCE on their edited pixels.
    dense = (pixel_weight >= 1.0).flatten(2).all(dim=2).float()
    overlap_weight = w * dense
    overlap = ((overlap * overlap_weight).sum() /
               overlap_weight.sum().clamp(min=1e-6))
    return bce + overlap


@torch.no_grad()
def iou(logits, target, thr=0.5, sample_weight=None):
    """Per-channel IoU, averaged over the samples that supervise that channel."""
    p = (torch.sigmoid(logits) > thr).float()
    target = (target > thr).float()
    inter = (p * target).sum(dim=(2, 3))
    union = ((p + target) > 0).float().sum(dim=(2, 3))
    per = inter / union.clamp(min=1)                        # (B, C)
    if sample_weight is None:
        m = torch.ones_like(per)
    else:
        m = (sample_weight > 0).float()
    n = m.sum(dim=0)
    # return the count too: a batch with no back-supervised sample must not be
    # averaged in as a zero by the caller
    return (per * m).sum(dim=0) / n.clamp(min=1), n
