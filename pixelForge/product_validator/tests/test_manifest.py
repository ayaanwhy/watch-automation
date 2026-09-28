import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from product_validator.manifest import audit_manifest, deduplicate, load_manifest


class ManifestTests(unittest.TestCase):
    def test_deduplicate_retains_alias(self):
        base = {"sha256": "a" * 64, "group_id": "g", "source": "s",
                "labels": {"asset": None, "view": None,
                           "suitable": None, "quality": None}}
        cases = [dict(base, id="b", image="b.png"),
                 dict(base, id="a", image="a.png")]
        result = deduplicate(cases)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "a")
        self.assertEqual(result[0]["aliases"][0]["id"], "b")

    def test_deduplicate_prefers_complete_labels(self):
        unknown = {"id": "a", "image": "a.png", "sha256": "b" * 64,
                   "group_id": "a", "source": "review", "labels": {
                       "asset": None, "view": None, "suitable": None,
                       "quality": None}}
        known = {"id": "z", "image": "z.png", "sha256": "b" * 64,
                 "group_id": "z", "source": "trusted", "labels": {
                     "asset": "ring", "view": "front", "suitable": True,
                     "quality": []}}
        result = deduplicate([unknown, known])
        self.assertEqual(result[0]["id"], "z")
        self.assertEqual(result[0]["aliases"][0]["id"], "a")

    def test_deduplicate_merges_compatible_partial_labels(self):
        first = {"id": "a", "image": "a.png", "sha256": "c" * 64,
                 "group_id": "a", "source": "one", "labels": {
                     "asset": "gemstone", "view": None, "suitable": None,
                     "quality": None}}
        second = {"id": "b", "image": "b.png", "sha256": "c" * 64,
                  "group_id": "b", "source": "two", "labels": {
                      "asset": "gemstone", "view": "front",
                      "suitable": True, "quality": []}}
        result = deduplicate([first, second])
        self.assertEqual(result[0]["labels"], second["labels"])

    def test_audit_detects_changed_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "image.png"
            Image.new("RGB", (8, 8), "white").save(image)
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({
                "schema_version": 1, "path_base": ".", "cases": [{
                    "id": "one", "image": "image.png", "sha256": digest,
                    "group_id": "one", "source": "test", "labels": {
                        "asset": "ring", "view": "front", "suitable": True,
                        "quality": []}}]}))
            self.assertEqual(load_manifest(manifest)["cases"][0]["id"], "one")
            Image.new("RGB", (8, 8), "black").save(image)
            self.assertEqual(audit_manifest(manifest)["changed_images"], ["one"])


if __name__ == "__main__":
    unittest.main()
