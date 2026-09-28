import unittest

import torch

from product_validator.losses import masked_binary_cross_entropy, multitask_loss
from product_validator.model import ProductValidator
from product_validator.taxonomy import QUALITY_FLAGS, ROTATION_CLASSES


class ModelAndLossTests(unittest.TestCase):
    def test_output_shapes(self):
        model = ProductValidator(pretrained=False).eval()
        with torch.inference_mode():
            outputs = model(torch.zeros(2, 3, 64, 64))
        self.assertEqual([tuple(value.shape) for value in outputs],
                         [(2, 3), (2, 4), (2, len(ROTATION_CLASSES)), (2, 1),
                          (2, len(QUALITY_FLAGS))])

    def test_all_unknown_loss_is_differentiable_zero(self):
        quality_count = len(QUALITY_FLAGS)
        outputs = tuple(torch.randn(*shape, requires_grad=True) for shape in
                        ((2, 3), (2, 4), (2, len(ROTATION_CLASSES)),
                         (2, 1), (2, quality_count)))
        batch = {
            "asset": torch.full((2,), -1, dtype=torch.long),
            "view": torch.full((2,), -1, dtype=torch.long),
            "rotation": torch.full((2,), -1, dtype=torch.long),
            "suitable": torch.full((2,), -1.0),
            "quality": torch.full((2, quality_count), -1.0),
        }
        loss, _ = multitask_loss(outputs, batch)
        self.assertEqual(float(loss.detach()), 0.0)
        loss.backward()

    def test_multilabel_positive_weights_preserve_columns(self):
        quality_count = len(QUALITY_FLAGS)
        logits = torch.zeros(2, quality_count, requires_grad=True)
        target = torch.zeros(2, quality_count, dtype=torch.float32)
        target[0, 0] = 1
        target[1] = -1
        weights = torch.ones(quality_count)
        weights[0] = 3
        loss = masked_binary_cross_entropy(
            logits, target, weights)
        self.assertTrue(torch.isfinite(loss))
        loss.backward()


if __name__ == "__main__":
    unittest.main()
