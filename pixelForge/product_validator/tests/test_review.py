import unittest

from product_validator.review import _incomplete


def case(labels):
    return {"labels": labels}


class ReviewQueueTests(unittest.TestCase):
    def test_known_other_does_not_require_irrelevant_labels(self):
        self.assertFalse(_incomplete(case({
            "asset": "other", "view": None, "rotation": None,
            "suitable": False, "quality": None,
        })))

    def test_supported_product_requires_orientation_and_quality(self):
        self.assertTrue(_incomplete(case({
            "asset": "ring", "view": "front", "rotation": None,
            "suitable": True, "quality": [],
        })))
        self.assertFalse(_incomplete(case({
            "asset": "ring", "view": "front", "rotation": "none",
            "suitable": True, "quality": [],
        })))


if __name__ == "__main__":
    unittest.main()
