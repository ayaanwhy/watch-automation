import unittest

from product_validator.policy import decide
from product_validator.taxonomy import QUALITY_FLAGS, ROTATION_CLASSES


def probabilities(asset, view="front", rotation="none", suitable=0.99,
                  quality=None):
    assets = {"ring": 0.01, "gemstone": 0.01, "other": 0.01}
    assets.update(asset)
    views = {"front": 0.01, "side": 0.01, "angled": 0.01, "rear": 0.01}
    views[view] = 0.97
    rotations = {name: 0.01 for name in ROTATION_CLASSES}
    rotations[rotation] = 0.97
    flags = {name: 0.01 for name in QUALITY_FLAGS}
    flags.update(quality or {})
    return {"asset": assets, "view": views, "rotation": rotations,
            "suitable": suitable,
            "quality": flags}


class PolicyTests(unittest.TestCase):
    def test_accepts_clear_matching_product(self):
        result = decide(probabilities({"ring": 0.98}), "ring")
        self.assertEqual(result["status"], "accepted")

    def test_rejects_confident_other_product(self):
        result = decide(probabilities({"other": 0.98}), "ring")
        self.assertEqual(result["code"], "unsupported_product")

    def test_uncertain_is_not_hard_rejected(self):
        result = decide(probabilities(
            {"ring": 0.60, "gemstone": 0.20, "other": 0.20}), "ring")
        self.assertEqual(result["status"], "uncertain")

    def test_rejects_wrong_view(self):
        result = decide(probabilities({"ring": 0.98}, view="side"), "ring")
        self.assertEqual(result["code"], "unsupported_view")

    def test_returns_explicit_orientation_correction(self):
        result = decide(probabilities(
            {"ring": 0.98}, rotation="rotate_right"), "ring")
        self.assertEqual(result["status"], "correctable")
        self.assertEqual(result["correction"], {
            "operation": "rotate_right", "degrees": 90})


if __name__ == "__main__":
    unittest.main()
