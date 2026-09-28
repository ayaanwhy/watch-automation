import unittest

import numpy as np

from benchmark.correction_workflow import encode_binary_mask
from benchmark.materialize_ownership_corrections import apply_exported_masks


class MaterializeOwnershipCorrectionsTests(unittest.TestCase):
    def setUp(self):
        self.full = np.zeros((8, 10), dtype=np.uint8)
        self.full[1:7, 2:8] = 255
        # Retained feathering must be copied exactly, never binarized.
        self.full[1, 3:7] = np.array([23, 91, 177, 239], dtype=np.uint8)
        self.back = np.zeros_like(self.full, dtype=bool)
        self.back[5:7, 3:7] = True

    def test_legacy_v2_payload_keeps_original_full_matte(self):
        state = {"back_runs": encode_binary_mask(self.back)}
        support, back, full, front, back_alpha = apply_exported_masks(
            self.full, state)

        np.testing.assert_array_equal(support, self.full > 0)
        np.testing.assert_array_equal(back, self.back)
        np.testing.assert_array_equal(full, self.full)
        np.testing.assert_array_equal(np.maximum(front, back_alpha), self.full)
        self.assertFalse(np.any((front > 0) & (back_alpha > 0)))

    def test_full_removal_deletes_from_both_layers_and_preserves_edge_alpha(self):
        support = self.full > 0
        removed = np.zeros_like(support)
        removed[1:3, 4:6] = True
        support[removed] = False
        back = self.back & support
        state = {
            "full_runs": encode_binary_mask(support),
            "back_runs": encode_binary_mask(back),
        }

        corrected_support, corrected_back, full, front, back_alpha = \
            apply_exported_masks(self.full, state)

        self.assertFalse(np.any(corrected_support[removed]))
        self.assertFalse(np.any(corrected_back[removed]))
        self.assertFalse(np.any(full[removed]))
        self.assertFalse(np.any(front[removed]))
        self.assertFalse(np.any(back_alpha[removed]))
        retained = corrected_support
        np.testing.assert_array_equal(full[retained], self.full[retained])
        np.testing.assert_array_equal(np.maximum(front, back_alpha), full)
        self.assertFalse(np.any((front > 0) & (back_alpha > 0)))

    def test_full_addition_becomes_opaque_front_matte(self):
        support = self.full > 0
        support[0, 0] = True
        corrected_support, corrected_back, full, front, back_alpha = \
            apply_exported_masks(self.full, {
                "full_runs": encode_binary_mask(support),
                "back_runs": encode_binary_mask(self.back),
            })
        self.assertTrue(corrected_support[0, 0])
        self.assertFalse(corrected_back[0, 0])
        self.assertEqual(int(full[0, 0]), 255)
        self.assertEqual(int(front[0, 0]), 255)
        self.assertEqual(int(back_alpha[0, 0]), 0)

    def test_back_cannot_exist_outside_corrected_full(self):
        support = self.full > 0
        support[5, 4] = False
        with self.assertRaisesRegex(ValueError, "outside the corrected full matte"):
            apply_exported_masks(self.full, {
                "full_runs": encode_binary_mask(support),
                "back_runs": encode_binary_mask(self.back),
            })


if __name__ == "__main__":
    unittest.main()
