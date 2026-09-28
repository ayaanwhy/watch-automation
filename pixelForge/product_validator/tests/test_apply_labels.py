import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from product_validator.apply_labels import apply_decisions
from product_validator.dataset import manifest_fingerprint
from product_validator.manifest import load_manifest


class ApplyLabelsTests(unittest.TestCase):
    def test_applies_hash_bound_decision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "one.png"
            image.write_bytes(b"not opened by this test")
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            image_two = root / "two.png"
            image_two.write_bytes(b"second image")
            digest_two = hashlib.sha256(image_two.read_bytes()).hexdigest()
            manifest_path = root / "manifest.json"
            payload = {"schema_version": 1, "path_base": ".", "cases": [{
                "id": "one", "image": "one.png", "sha256": digest,
                "group_id": "one", "source": "test", "labels": {
                    "asset": None, "view": None, "suitable": None,
                    "rotation": None, "quality": None}}, {
                "id": "two", "image": "two.png", "sha256": digest_two,
                "group_id": "two", "source": "test", "labels": {
                    "asset": None, "view": None, "suitable": None,
                    "rotation": None, "quality": None}}]}
            manifest_path.write_text(json.dumps(payload))
            loaded = load_manifest(manifest_path)
            decisions = root / "decisions.json"
            decisions.write_text(json.dumps({
                "schema_version": 2,
                "manifest_fingerprint": manifest_fingerprint(loaded),
                "created_at": "2026-09-02T00:00:00Z",
                "decisions": [{"id": "one", "sha256": digest, "labels": {
                    "asset": "other", "view": None, "suitable": False,
                    "rotation": None, "quality": []}}]}))
            decisions_two = root / "decisions-two.json"
            decisions_two.write_text(json.dumps({
                "schema_version": 2,
                "manifest_fingerprint": manifest_fingerprint(loaded),
                "created_at": "2026-09-02T00:00:01Z",
                "decisions": [{"id": "two", "sha256": digest_two,
                               "labels": {"asset": "ring", "view": "side",
                                          "rotation": "none",
                                          "suitable": False,
                                          "quality": []}}]}))
            output = root / "reviewed.json"
            apply_decisions(manifest_path, [decisions, decisions_two], output)
            reviewed = load_manifest(output)["cases"]
            case = reviewed[0]
            self.assertEqual(case["labels"]["asset"], "other")
            self.assertEqual(case["label_source"], "manual_validator_review")
            self.assertEqual(reviewed[1]["labels"]["view"], "side")


if __name__ == "__main__":
    unittest.main()
