import tempfile
import unittest
from pathlib import Path

from product_validator.isolation import HERE, safe_output, verify_production_models


class IsolationTests(unittest.TestCase):
    def test_current_production_models_match_baseline(self):
        self.assertTrue(verify_production_models()["unchanged"])

    def test_output_cannot_escape_allowed_folder(self):
        with self.assertRaises(ValueError):
            safe_output(Path("deploy/do-not-write.onnx"), HERE / "exports")


if __name__ == "__main__":
    unittest.main()
