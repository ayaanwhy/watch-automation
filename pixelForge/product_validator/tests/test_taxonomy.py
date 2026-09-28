import unittest

from product_validator.taxonomy import readiness, validate_labels


class TaxonomyTests(unittest.TestCase):
    def test_rejects_unknown_quality_flag(self):
        with self.assertRaisesRegex(ValueError, "unsupported quality"):
            validate_labels({"asset": "ring", "view": "front",
                             "rotation": "none", "suitable": True,
                             "quality": ["blurryish"]})

    def test_rotation_direction_requires_front_view(self):
        with self.assertRaisesRegex(ValueError, "front camera view"):
            validate_labels({"asset": "ring", "view": "side",
                             "rotation": "rotate_right", "suitable": True,
                             "quality": []})

    def test_readiness_reports_shortages(self):
        cases = [{"group_id": "one", "labels": {
            "asset": "ring", "view": "front", "suitable": True,
            "rotation": "none", "quality": []}}]
        report = readiness(cases)
        self.assertFalse(report["ready"])
        self.assertEqual(report["counts"]["asset:ring"], 1)
        self.assertIn("asset:other", report["shortages"])


if __name__ == "__main__":
    unittest.main()
