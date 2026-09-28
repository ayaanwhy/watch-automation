import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np

from ring_v2.labels.prepare_agreement import prepare, sha256_file


class PrepareAgreementTests(unittest.TestCase):
    def test_requires_exactly_forty_unique_cases_and_builds_independent_lanes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            cases = []
            snapshot_cases = []
            for index in range(40):
                case_id = f"case-{index:02d}"
                path = source / f"{case_id}.jpg"
                image = np.full((10, 12, 3), index + 20, np.uint8)
                self.assertTrue(cv2.imwrite(str(path), image))
                digest = sha256_file(path)
                cases.append({"case_id": case_id, "category": "test",
                              "focus": ["coverage"]})
                snapshot_cases.append({
                    "id": case_id, "status": "ok", "selected": {},
                    "image": {"sha256": digest,
                              "file": f"images/{digest}.jpg"},
                })
            selection = root / "selection.json"
            selection.write_text(json.dumps({
                "selection_id": "test-40", "label_contract": "test-contract",
                "seed": 1, "cases": cases,
            }))
            snapshot = root / "manifest.json"
            snapshot.write_text(json.dumps({
                "snapshot_id": "test-snapshot", "cases": snapshot_cases,
            }))
            output = root / "out"

            manifest = prepare(selection, snapshot, source, output)

            self.assertEqual(manifest["source_count"], 40)
            self.assertEqual(manifest["unique_source_hashes"], 40)
            self.assertFalse(manifest["model_predictions_included"])
            self.assertEqual(len(list((output / "source").glob("*.jpg"))), 40)
            self.assertTrue((output / "contact-sheet-source-only.jpg").is_file())
            for lane in ("editor-a", "editor-b"):
                self.assertTrue((output / lane / "returned").is_dir())
                order = (output / lane / "order.txt").read_text().splitlines()
                self.assertEqual(set(order), {case["case_id"] for case in cases})
            self.assertNotEqual(
                (output / "editor-a" / "order.txt").read_text(),
                (output / "editor-b" / "order.txt").read_text())

    def test_refuses_to_overwrite_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "out"
            output.mkdir()
            with self.assertRaisesRegex(FileExistsError, "refusing to overwrite"):
                prepare(root / "missing-selection", root / "missing-manifest",
                        root / "missing-source", output)


if __name__ == "__main__":
    unittest.main()
