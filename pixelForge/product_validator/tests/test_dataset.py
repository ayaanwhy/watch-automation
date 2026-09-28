import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from PIL import Image
from torch.utils.data import DataLoader

from product_validator.dataset import (ValidatorDataset, image_transform,
                                       split_groups, synthetic_rotation)
from product_validator.infer import prepare_image
from product_validator.manifest import sha256_file
from product_validator.taxonomy import ROTATION_CLASSES


def case(case_id, group, asset, view):
    return {"id": case_id, "group_id": group, "labels": {
        "asset": asset, "view": view, "suitable": True, "quality": []}}


class SplitTests(unittest.TestCase):
    def test_fill_step_preserves_rare_class_in_training(self):
        cases = [case(str(i), str(i), "gemstone" if i < 2 else "ring", "front")
                 for i in range(20)]
        for seed in range(50):
            train, val, _ = split_groups(cases, 0.2, seed)
            self.assertEqual({row["labels"]["asset"] for row in train},
                             {"ring", "gemstone"})
            self.assertEqual({row["labels"]["asset"] for row in val},
                             {"ring", "gemstone"})

    def test_singleton_label_stays_in_training(self):
        cases = [case(str(i), str(i), "gemstone" if i == 0 else "ring", "front")
                 for i in range(10)]
        train, val, _ = split_groups(cases, 0.9, 42)
        self.assertIn("0", {row["id"] for row in train})
        self.assertEqual(len(train), 2)
        self.assertTrue(val)

    def test_impossible_split_requires_more_groups(self):
        with self.assertRaisesRegex(ValueError, "collect more independent"):
            split_groups([case("a", "a", "ring", "front"),
                          case("b", "b", "gemstone", "front")])

    def test_split_is_deterministic_and_group_safe(self):
        cases = [
            case("a1", "a", "ring", "front"),
            case("a2", "a", "ring", "front"),
            case("b", "b", "ring", "side"),
            case("c", "c", "gemstone", "front"),
            case("d", "d", "gemstone", "side"),
            case("e", "e", "other", None),
            case("f", "f", "other", None),
        ]
        train1, val1, groups1 = split_groups(cases, 0.4, 17)
        train2, val2, groups2 = split_groups(cases, 0.4, 17)
        self.assertEqual(groups1, groups2)
        self.assertEqual([row["id"] for row in train1],
                         [row["id"] for row in train2])
        self.assertEqual([row["id"] for row in val1],
                         [row["id"] for row in val2])
        train_groups = {row["group_id"] for row in train1}
        val_groups = {row["group_id"] for row in val1}
        self.assertFalse(train_groups & val_groups)
        self.assertEqual(val_groups, groups1)

    def test_synthetic_rotation_is_inverse_of_requested_correction(self):
        image = Image.new("RGB", (3, 2))
        rotated = synthetic_rotation(image, "rotate_right")
        self.assertEqual(rotated.size, (2, 3))
        restored = rotated.transpose(Image.Transpose.ROTATE_270)
        self.assertEqual(restored.size, image.size)


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.image_path = root / "image.png"
        image = Image.new("RGBA", (40, 24), (0, 0, 0, 0))
        image.paste((210, 30, 80, 255), (4, 3, 15, 19))
        image.save(self.image_path)
        self.row = dict(case("one", "one", "ring", "front"),
                        image="image.png", source="test",
                        sha256=sha256_file(self.image_path))
        self.row["labels"]["rotation"] = "none"
        self.manifest = root / "manifest.json"
        self.manifest.write_text(json.dumps({
            "schema_version": 1, "path_base": ".", "cases": [self.row]}))

    def test_training_and_validation_load_real_batches(self):
        for train in (False, True):
            with self.subTest(train=train):
                dataset = ValidatorDataset(self.manifest, [self.row], 32, train)
                batch = next(iter(DataLoader(dataset, batch_size=1)))
                self.assertEqual(batch["image"].shape, (1, 3, 32, 32))
                self.assertTrue(torch.isfinite(batch["image"]).all())
                self.assertEqual(batch["asset"].item(), 0)
                self.assertEqual(batch["suitable"].item(), 1)

    def test_validation_is_repeatable_and_matches_onnx_preprocessing(self):
        dataset = ValidatorDataset(self.manifest, [self.row], 32, False)
        with patch("product_validator.dataset.torch.rand") as draw:
            first, second = dataset[0], dataset[0]
        draw.assert_not_called()
        torch.testing.assert_close(first["image"], second["image"], rtol=0, atol=0)
        np.testing.assert_allclose(first["image"].numpy()[None],
                                   prepare_image(self.image_path, 32), atol=1e-6)
        self.assertEqual(first["rotation"].item(), 0)

    def test_training_rotation_changes_pixels_and_label_together(self):
        dataset = ValidatorDataset(self.manifest, [self.row], 32, True)
        # Isolate the rotation from affine/colour augmentation.
        dataset.transform = image_transform(32, train=False)
        baseline = ValidatorDataset(self.manifest, [self.row], 32, False)[0]
        for index, correction in enumerate(ROTATION_CLASSES[1:]):
            with self.subTest(correction=correction), \
                    patch("product_validator.dataset.torch.rand", return_value=torch.tensor(0.0)), \
                    patch("product_validator.dataset.torch.randint", return_value=torch.tensor(index)):
                sample = dataset[0]
            self.assertEqual(sample["rotation"].item(), index + 1)
            self.assertFalse(torch.equal(sample["image"], baseline["image"]))
            self.assertEqual(self.row["labels"]["rotation"], "none")


if __name__ == "__main__":
    unittest.main()
