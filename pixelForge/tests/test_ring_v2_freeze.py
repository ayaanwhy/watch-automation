import base64
import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np

from ring_v2.freeze_production import (
    compare_capture, copy_runtime, decode_png, image_difference,
    normalized_metadata, restore_source_canvas, rollback_instructions,
    seal_tree, sha256_bytes, sha256_file,
)


class FreezeProductionTests(unittest.TestCase):
    def test_sha256_helpers_match(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "value.bin"
            path.write_bytes(b"ring-v2")
            self.assertEqual(sha256_file(path), sha256_bytes(b"ring-v2"))

    def test_decode_png_requires_rgba(self):
        rgba = np.zeros((4, 5, 4), np.uint8)
        rgba[..., 3] = 255
        ok, encoded = cv2.imencode(".png", rgba)
        self.assertTrue(ok)

        data, decoded = decode_png(base64.b64encode(encoded).decode())

        self.assertTrue(data)
        self.assertEqual(decoded.shape, (4, 5, 4))

    def test_normalized_metadata_removes_layers_and_timing(self):
        payload = {
            "full": "a", "front": "b", "back": "c", "ms": 12.3,
            "crop": {"x": 2}, "needs_review": False,
        }
        self.assertEqual(normalized_metadata(payload), {
            "crop": {"x": 2}, "needs_review": False,
        })

    def test_capture_comparison_requires_metadata_and_layer_hashes(self):
        def capture(name, full="f"):
            return {
                "name": name,
                "cases": [{
                    "case_id": "sample",
                    "attempts": [{
                        "metadata": {"crop": 1},
                        "layers": {
                            "full": {"sha256": full},
                            "front": {"sha256": "r"},
                            "back": {"sha256": "b"},
                        },
                    }],
                }],
            }

        self.assertTrue(compare_capture(capture("a"), capture("b"))["all_exact"])
        changed = compare_capture(capture("a"), capture("b", full="changed"))
        self.assertFalse(changed["all_exact"])
        self.assertFalse(changed["all_compatible"])
        self.assertFalse(changed["cases"][0]["attempts"][0]["exact"])

    def test_image_difference_accepts_small_known_rng_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            left = np.zeros((100, 100, 4), np.uint8)
            right = left.copy()
            right[0, 0] = 1
            left_path = Path(directory) / "left.png"
            right_path = Path(directory) / "right.png"
            self.assertTrue(cv2.imwrite(str(left_path), left))
            self.assertTrue(cv2.imwrite(str(right_path), right))

            result = image_difference(left_path, right_path)

            self.assertTrue(result["compatible"])
            self.assertEqual(result["changed_pixels"], 1)

    def test_image_difference_rejects_material_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            left = np.zeros((10, 10, 4), np.uint8)
            right = np.full_like(left, 255)
            left_path = Path(directory) / "left.png"
            right_path = Path(directory) / "right.png"
            self.assertTrue(cv2.imwrite(str(left_path), left))
            self.assertTrue(cv2.imwrite(str(right_path), right))

            self.assertFalse(image_difference(
                left_path, right_path)["compatible"])

    def test_restore_source_canvas_makes_different_crops_comparable(self):
        left = np.ones((2, 3, 4), np.uint8)
        right = np.ones((3, 4, 4), np.uint8)
        right[2] = 0
        right[:, 3] = 0
        left_metadata = {
            "source_width": 8, "source_height": 7,
            "crop": {"x": 2, "y": 3, "width": 3, "height": 2},
        }
        right_metadata = {
            "source_width": 8, "source_height": 7,
            "crop": {"x": 2, "y": 3, "width": 4, "height": 3},
        }

        left_canvas = restore_source_canvas(left, left_metadata)
        right_canvas = restore_source_canvas(right, right_metadata)

        np.testing.assert_array_equal(left_canvas, right_canvas)

    def test_copy_runtime_fails_if_contract_file_is_missing(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as out:
            with self.assertRaisesRegex(FileNotFoundError, "required runtime file"):
                copy_runtime(Path(source), Path(out))

    def test_seal_tree_is_deterministic_and_excludes_itself(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "b.txt").write_text("b")
            (root / "a.txt").write_text("a")
            (root / "seal.json").write_text(json.dumps({"old": True}))

            first = seal_tree(root)
            second = seal_tree(root)

            self.assertEqual(first["files"], second["files"])
            self.assertEqual(
                [item["path"] for item in first["files"]],
                ["a.txt", "b.txt"])
            self.assertEqual(first["content_manifest_sha256"],
                             second["content_manifest_sha256"])

    def test_rollback_instructions_use_cpu_and_smoke_source(self):
        instructions = rollback_instructions()
        self.assertIn("RING_PROVIDER=CPUExecutionProvider", instructions)
        self.assertIn("smoke/sources/core-round-4-prongs-single.jpg", instructions)


if __name__ == "__main__":
    unittest.main()
