import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from benchmark.generate_suite import generate_cases
from vto.configurator_benchmark import binary_iou, mask_metrics, runtime_metadata


class ConfiguratorBenchmarkTests(unittest.TestCase):
    def test_ultimate_suite_case_ids_are_unique(self):
        cases = generate_cases()
        self.assertEqual(len(cases), 606)
        self.assertEqual(len({case["id"] for case in cases}), len(cases))

    def test_valid_partition_passes_integrity_checks(self):
        full = np.zeros((80, 80), np.float32)
        full[8:72, 8:72] = 1
        back = np.zeros_like(full)
        back[56:72, 8:72] = 1
        front = full - back
        metrics = mask_metrics(full, front, back)
        self.assertEqual(metrics["flags"], [])
        self.assertEqual(metrics["front_px"] + metrics["back_px"],
                         metrics["full_px"])

    def test_partition_overlap_is_flagged(self):
        full = np.zeros((20, 20), np.float32)
        full[4:16, 4:16] = 1
        metrics = mask_metrics(full, full, full)
        self.assertIn("invalid_layer_partition", metrics["flags"])

    def test_tiny_isolated_back_component_is_flagged(self):
        full = np.zeros((80, 80), np.float32)
        full[8:72, 8:72] = 1
        back = np.zeros_like(full)
        back[56:72, 8:72] = 1
        back[12:14, 12:14] = 1
        front = full - back
        metrics = mask_metrics(full, front, back)
        self.assertEqual(metrics["tiny_back_components"], 1)
        self.assertIn("tiny_back_components", metrics["flags"])
        self.assertIn("multiple_back_components", metrics["flags"])

    def test_two_large_back_components_are_flagged(self):
        full = np.zeros((80, 120), np.float32)
        full[20:60, 10:50] = 1.0
        full[20:60, 70:110] = 1.0
        back = full.copy()
        metrics = mask_metrics(full, np.zeros_like(full), back)
        self.assertEqual(metrics["back_solid_components"], 2)
        self.assertIn("multiple_back_components", metrics["flags"])

    def test_two_aligned_lower_band_halves_are_a_valid_occlusion(self):
        full = np.zeros((100, 180), np.float32)
        back = np.zeros_like(full)
        back[65:85, 10:75] = 1.0
        back[66:85, 105:170] = 1.0
        full[30:85, 10:170] = 1.0
        front = full - back
        metrics = mask_metrics(full, front, back)
        self.assertEqual(metrics["back_solid_components"], 2)
        self.assertTrue(metrics["valid_occluded_back_halves"])
        self.assertNotIn("multiple_back_components", metrics["flags"])

    def test_perspective_occluded_back_halves_are_a_valid_occlusion(self):
        full = np.zeros((180, 500), np.float32)
        back = np.zeros_like(full)
        back[55:135, 10:210] = 1.0
        back[35:155, 270:490] = 1.0
        full[20:155, 10:490] = 1.0
        front = full - back
        metrics = mask_metrics(full, front, back)
        self.assertEqual(metrics["back_solid_components"], 2)
        self.assertTrue(metrics["valid_occluded_back_halves"])
        self.assertNotIn("multiple_back_components", metrics["flags"])

    def test_tall_perspective_back_mate_is_a_valid_occlusion(self):
        full = np.zeros((120, 180), np.float32)
        back = np.zeros_like(full)
        back[63:100, 112:168] = 1.0
        back[62:100, 12:68] = 1.0  # 56x38, aspect 1.47
        full[30:100, 12:168] = 1.0
        front = full - back
        metrics = mask_metrics(full, front, back)
        self.assertEqual(metrics["back_solid_components"], 2)
        self.assertTrue(metrics["valid_occluded_back_halves"])
        self.assertNotIn("multiple_back_components", metrics["flags"])

    def test_matte_only_gemstone_partition_passes(self):
        full = np.zeros((40, 40), np.float32)
        full[8:32, 8:32] = 1
        metrics = mask_metrics(full, full.copy(), np.zeros_like(full),
                               expect_back=False)
        self.assertEqual(metrics["flags"], [])
        self.assertFalse(metrics["expects_back"])

    def test_matte_only_gemstone_rejects_back_pixels(self):
        full = np.zeros((40, 40), np.float32)
        full[8:32, 8:32] = 1
        back = np.zeros_like(full)
        back[24:32, 8:32] = 1
        metrics = mask_metrics(full, full - back, back, expect_back=False)
        self.assertIn("unexpected_back_pixels", metrics["flags"])

    def test_partial_alpha_dust_is_flagged(self):
        full = np.zeros((40, 40), np.float32)
        full[8:32, 8:32] = 1
        full[2:4, 36:38] = 0.1
        back = np.zeros_like(full)
        back[24:32, 8:32] = 1
        metrics = mask_metrics(full, full - back, back)
        self.assertEqual(metrics["tiny_alpha_components"], 1)
        self.assertIn("tiny_alpha_components", metrics["flags"])

    def test_binary_iou(self):
        left = np.zeros((4, 4), np.uint8)
        right = np.zeros_like(left)
        left[1:3, 1:3] = 255
        right[1:3, 2:4] = 255
        self.assertAlmostEqual(binary_iou(left, right), 2 / 6)

    def test_runtime_signature_depends_on_model_bytes_not_path(self):
        previous = os.environ.get("RING_MODEL")
        try:
            with tempfile.TemporaryDirectory() as root:
                left, right = Path(root) / "left.onnx", Path(root) / "right.onnx"
                left.write_bytes(b"same model")
                right.write_bytes(b"same model")
                os.environ["RING_MODEL"] = str(left)
                a = runtime_metadata(left)
                os.environ["RING_MODEL"] = str(right)
                b = runtime_metadata(right)
                self.assertEqual(a["signature"], b["signature"])
        finally:
            if previous is None:
                os.environ.pop("RING_MODEL", None)
            else:
                os.environ["RING_MODEL"] = previous

    def test_runtime_signature_hashes_optional_ownership_refiner(self):
        previous = os.environ.get("RING_OWNERSHIP_REFINER")
        try:
            with tempfile.TemporaryDirectory() as root:
                model = Path(root) / "model.onnx"
                refiner = Path(root) / "refiner.onnx"
                model.write_bytes(b"base")
                refiner.write_bytes(b"first")
                os.environ["RING_OWNERSHIP_REFINER"] = str(refiner)
                first = runtime_metadata(model)
                refiner.write_bytes(b"second")
                second = runtime_metadata(model)
                self.assertNotEqual(first["signature"], second["signature"])
        finally:
            if previous is None:
                os.environ.pop("RING_OWNERSHIP_REFINER", None)
            else:
                os.environ["RING_OWNERSHIP_REFINER"] = previous

    def test_runtime_signature_hashes_default_refiner_and_metadata(self):
        previous = os.environ.pop("RING_OWNERSHIP_REFINER", None)
        previous_cwd = os.getcwd()
        try:
            with tempfile.TemporaryDirectory() as root, patch(
                    "vto.configurator_benchmark.RUNTIME_FILES", ()):
                os.chdir(root)
                deploy = Path("deploy")
                deploy.mkdir()
                model = deploy / "model.onnx"
                model.write_bytes(b"base")
                (deploy / "model.json").write_text("{}")
                refiner = deploy / "ownership_refiner.onnx"
                metadata = deploy / "ownership_refiner.json"
                refiner.write_bytes(b"first")
                metadata.write_text('{"release":"one"}')
                first = runtime_metadata(model.resolve())
                refiner.write_bytes(b"second")
                second = runtime_metadata(model.resolve())
                metadata.write_text('{"release":"two"}')
                third = runtime_metadata(model.resolve())
                self.assertNotEqual(first["signature"], second["signature"])
                self.assertNotEqual(second["signature"], third["signature"])
        finally:
            os.chdir(previous_cwd)
            if previous is not None:
                os.environ["RING_OWNERSHIP_REFINER"] = previous


if __name__ == "__main__":
    unittest.main()
