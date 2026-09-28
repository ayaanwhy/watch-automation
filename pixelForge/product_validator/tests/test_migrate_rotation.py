import unittest

from product_validator.migrate_rotation import legacy_rotation


class RotationMigrationTests(unittest.TestCase):
    def test_defaults_reviewed_product_views_to_upright(self):
        self.assertEqual(legacy_rotation({
            "asset": "ring", "view": "side"}), "none")
        self.assertEqual(legacy_rotation({
            "asset": "gemstone", "view": "front"}), "none")

    def test_leaves_unknown_and_other_orientation_unlabeled(self):
        self.assertIsNone(legacy_rotation({
            "asset": "ring", "view": None}))
        self.assertIsNone(legacy_rotation({
            "asset": "other", "view": None}))


if __name__ == "__main__":
    unittest.main()
