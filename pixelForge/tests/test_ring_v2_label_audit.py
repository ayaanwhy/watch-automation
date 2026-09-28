import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np

from ring_v2.labels import LABEL_CONTRACT
from ring_v2.labels.audit import audit, derive_targets, sha256_file
from ring_v2.labels.compare_agreement import compare, compare_targets


def write_rgba(path: Path, alpha: np.ndarray) -> None:
    image = np.zeros((*alpha.shape, 4), np.uint8)
    image[:, :, :3] = (180, 190, 200)
    image[:, :, 3] = alpha
    if not cv2.imwrite(str(path), image):
        raise OSError(path)


class RingV2LabelAuditTests(unittest.TestCase):
    def make_workspace(self, root: Path, case_id: str = "ring-one") -> tuple[Path, Path]:
        source_dir = root / "source"
        returned = root / "returned"
        source_dir.mkdir()
        returned.mkdir()
        source = np.full((24, 30, 3), 247, np.uint8)
        cv2.rectangle(source, (5, 5), (24, 19), (100, 120, 140), -1)
        source_path = source_dir / f"{case_id}.jpg"
        self.assertTrue(cv2.imwrite(str(source_path), source))
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps({
            "label_contract": LABEL_CONTRACT,
            "cases": [{
                "case_id": case_id,
                "source_file": f"source/{case_id}.jpg",
                "source_sha256": sha256_file(source_path),
            }],
        }))
        return manifest, returned

    @staticmethod
    def valid_alphas() -> tuple[np.ndarray, np.ndarray]:
        full = np.zeros((24, 30), np.uint8)
        full[5:20, 5:25] = 255
        full[4, 10:20] = 64
        front = np.zeros_like(full)
        front[5:12, 5:25] = 255
        front[4, 10:20] = 64
        return full, front

    def test_accepts_native_pair_and_writes_exact_partition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, returned = self.make_workspace(root)
            full, front = self.valid_alphas()
            write_rgba(returned / "ring-one;frontFullImage.png", full)
            write_rgba(returned / "ring-one;frontImage.png", front)

            report = audit(manifest, returned, root / "audit")

            self.assertTrue(report["summary"]["complete"])
            self.assertEqual(report["summary"]["accepted"], 1)
            self.assertEqual(report["summary"]["quarantined"], 0)
            record = report["cases"][0]
            self.assertEqual(record["status"], "accepted")
            with np.load(root / "audit" / record["target_file"]) as target:
                np.testing.assert_array_equal(
                    target["front_alpha"] + target["back_alpha"],
                    target["full_alpha"])
                assigned = np.isin(target["ownership"], (1, 2))
                self.assertFalse(np.any(assigned & target["ignore"]))
                self.assertTrue(np.all(target["ownership"][assigned] != 255))

    def test_wrong_dimensions_are_quarantined_without_resizing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, returned = self.make_workspace(root)
            write_rgba(returned / "ring-one;frontFullImage.png",
                       np.full((12, 15), 255, np.uint8))
            write_rgba(returned / "ring-one;frontImage.png",
                       np.full((12, 15), 255, np.uint8))

            report = audit(manifest, returned, root / "audit")

            self.assertEqual(report["summary"]["quarantined"], 1)
            self.assertIn("do not match source", report["cases"][0]["errors"][0])
            self.assertFalse(any((root / "audit" / "accepted").glob("*.npz")))

    def test_front_outside_full_is_quarantined(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, returned = self.make_workspace(root)
            full, front = self.valid_alphas()
            front[1, 1] = 255
            write_rgba(returned / "ring-one;frontFullImage.png", full)
            write_rgba(returned / "ring-one;frontImage.png", front)

            report = audit(manifest, returned, root / "audit")

            self.assertEqual(report["summary"]["quarantined"], 1)
            self.assertEqual(report["cases"][0]["containment"]["violation_pixels"], 1)
            self.assertTrue(any("exceeds full" in error
                                for error in report["cases"][0]["errors"]))

    def test_missing_pair_can_be_reported_as_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, returned = self.make_workspace(root)
            report = audit(manifest, returned, root / "audit", allow_missing=True)
            self.assertEqual(report["summary"]["missing"], 1)
            self.assertFalse(report["summary"]["complete"])
            self.assertTrue(report["exit_ok"])

    def test_unexpected_returned_file_fails_lane_qa(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, returned = self.make_workspace(root)
            (returned / "renamed-mask.PNG").write_bytes(b"not accepted")
            report = audit(manifest, returned, root / "audit", allow_missing=True)
            self.assertEqual(report["unexpected_files"], ["renamed-mask.PNG"])
            self.assertFalse(report["summary"]["qa_passed_for_present_labels"])
            self.assertFalse(report["exit_ok"])

    def test_changed_canonical_source_is_rejected_before_label_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, returned = self.make_workspace(root)
            (root / "source" / "ring-one.jpg").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "canonical source hash changed"):
                audit(manifest, returned, root / "audit", allow_missing=True)

    def test_ambiguous_and_low_alpha_pixels_are_ignored(self):
        full = np.ones((7, 7), np.float32)
        full[0, :] = 0.05
        front = np.ones_like(full)
        front[3, 3] = 0.5

        target = derive_targets(full, front)

        self.assertTrue(np.all(target["ignore"][0]))
        self.assertTrue(target["ignore"][3, 3])
        self.assertTrue(target["ignore"][2, 2])  # one-pixel seam dilation
        self.assertEqual(int(target["ownership"][3, 3]), 255)
        np.testing.assert_array_equal(
            target["front_alpha"] + target["back_alpha"], target["full_alpha"])


class RingV2AgreementTests(unittest.TestCase):
    @staticmethod
    def target(shift: int = 0) -> dict[str, np.ndarray]:
        full = np.zeros((32, 36), np.float32)
        full[5:27, 4 + shift:32 + shift] = 1.0
        front = np.zeros_like(full)
        front[5:16, 4 + shift:32 + shift] = 1.0
        return derive_targets(full, front)

    def test_identical_targets_have_perfect_agreement(self):
        first = self.target()
        metrics = compare_targets(first, first)
        self.assertEqual(metrics["full_iou"], 1.0)
        self.assertEqual(metrics["full_boundary_f1_1px"], 1.0)
        self.assertEqual(metrics["cldice"], 1.0)
        self.assertEqual(metrics["connectivity_error"], 0.0)
        self.assertEqual(metrics["ownership_agreement"], 1.0)
        self.assertEqual(metrics["ownership_seam_boundary_f1_2px"], 1.0)

    def test_shifted_target_records_disagreement(self):
        metrics = compare_targets(self.target(), self.target(shift=3))
        self.assertLess(metrics["full_iou"], 1.0)
        self.assertLess(metrics["full_boundary_f1_1px"], 1.0)
        self.assertGreater(metrics["gradient_error"], 0.0)

    def test_complete_audits_generate_source_only_review(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper = RingV2LabelAuditTests()
            manifest, returned_a = helper.make_workspace(root)
            returned_b = root / "returned-b"
            returned_b.mkdir()
            full, front = helper.valid_alphas()
            for returned in (returned_a, returned_b):
                write_rgba(returned / "ring-one;frontFullImage.png", full)
                write_rgba(returned / "ring-one;frontImage.png", front)
            audit(manifest, returned_a, root / "audit-a")
            audit(manifest, returned_b, root / "audit-b")

            report = compare(root / "audit-a", root / "audit-b", root / "comparison")

            self.assertEqual(report["case_count"], 1)
            self.assertFalse(report["model_predictions_included"])
            page = (root / "comparison" / "review.html").read_text()
            self.assertIn("No model predictions", page)
            self.assertTrue((root / "comparison" / "ADJUDICATION.md").is_file())


if __name__ == "__main__":
    unittest.main()
