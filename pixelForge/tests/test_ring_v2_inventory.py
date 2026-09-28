import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np

from ring_v2.data import inventory
from ring_v2.data.inventory import (
    ArtifactInspector, build_inventory, scan_editor_triples, sha256_file,
)


def write_rgba(path: Path, height: int, width: int, alpha_value: int = 255) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = np.zeros((height, width, 4), np.uint8)
    image[:, :, :3] = (110, 160, 210)
    image[1:-1, 1:-1, 3] = alpha_value
    if not cv2.imwrite(str(path), image):
        raise OSError(path)


def write_mask(path: Path, height: int, width: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = np.zeros((height, width), np.uint8)
    image[2:-2, 2:-2] = 255
    if not cv2.imwrite(str(path), image):
        raise OSError(path)


class RingV2InventoryTests(unittest.TestCase):
    def test_editor_triple_scanner_ignores_groups_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            edited = root / "edited"
            edited.mkdir()
            source = np.full((12, 14, 3), 247, np.uint8)
            self.assertTrue(cv2.imwrite(str(edited / "ring-one.jpg"), source))
            write_rgba(edited / "ring-one;frontFullImage.png", 12, 14)
            write_rgba(edited / "ring-one;frontImage.png", 12, 14)
            (edited / "groups.json").write_text(json.dumps({"ring-one": "design-one"}))
            spec = {
                "id": "edited", "asset_type": "ring",
                "provenance": "legacy_retoucher_pair",
                "routing": "compatibility_audit_required",
            }

            samples = scan_editor_triples(
                spec, edited, ArtifactInspector(root, root / "trash"))

            self.assertEqual([sample["case_id"] for sample in samples], ["ring-one"])
            self.assertTrue(samples[0]["complete"])

    def make_repo(self, root: Path) -> tuple[Path, Path, Path]:
        pair = root / "raw/pairs/ring-one"
        write_rgba(pair / "full.png", 20, 24, 180)
        write_rgba(pair / "front.png", 18, 24, 180)
        incomplete = root / "raw/pairs/ring-incomplete"
        write_rgba(incomplete / "full.png", 20, 24)

        mirror = root / "raw/pairs-mirror/ring-one"
        mirror.mkdir(parents=True)
        os.link(pair / "full.png", mirror / "full.png")
        os.link(pair / "front.png", mirror / "front.png")

        cache = root / "data/cache/ring-one_png"
        write_rgba(cache / "img.png", 16, 16)
        write_mask(cache / "back.png", 16, 16)
        (cache / "meta.json").write_text(json.dumps({"design_id": "ring-one"}))

        external = root / "external"
        external.mkdir()
        (external / "same-full.png").write_bytes((pair / "full.png").read_bytes())

        split = root / "runs/deployed/split.json"
        split.parent.mkdir(parents=True)
        split.write_text(json.dumps({
            "fingerprint": "fixture-fingerprint",
            "args": {"data": "data/cache"},
            "train_designs": ["ring-one"],
            "val_designs": [],
        }))

        config = root / "inventory.json"
        config.write_text(json.dumps({
            "inventory_id": "fixture-v1",
            "datasets": [
                {
                    "id": "pairs", "path": "raw/pairs", "scanner": "pair_dirs",
                    "asset_type": "ring", "provenance": "legacy_retoucher_pair",
                    "routing": "compatibility_audit_required",
                },
                {
                    "id": "pairs-mirror", "path": "raw/pairs-mirror",
                    "scanner": "pair_dirs", "asset_type": "ring",
                    "provenance": "legacy_retoucher_pair", "routing": "recovery_copy_only",
                },
                {
                    "id": "cache", "path": "data/cache", "scanner": "cache_dirs",
                    "asset_type": "ring", "provenance": "registered_jpg_legacy_or_cached_cutout",
                    "routing": "legacy_training_only",
                },
                {
                    "id": "external", "path": "external", "scanner": "source_images",
                    "asset_type": "ring", "provenance": "external_merchant_source",
                    "routing": "validator_labels_only_no_segmentation_truth",
                },
                {
                    "id": "missing", "path": "does-not-exist", "scanner": "source_images",
                    "asset_type": "ring", "provenance": "unknown",
                    "routing": "manual_classification_required",
                },
            ],
            "production_lineage": [{
                "component": "base", "run": "deployed", "split": "runs/deployed/split.json",
            }],
            "run_manifest_globs": ["runs/*/split.json"],
            "correction_exports": [],
            "archives": [],
        }))
        return config, pair, cache

    def test_inventory_is_read_only_and_tracks_lineage_geometry_and_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config, pair, cache = self.make_repo(root)
            inputs = [pair / "full.png", pair / "front.png", cache / "img.png"]
            before = {path: (sha256_file(path), path.stat().st_mtime_ns) for path in inputs}
            output = root / "out/inventory.json"

            report = build_inventory(config, root, root / "trash", output)

            after = {path: (sha256_file(path), path.stat().st_mtime_ns) for path in inputs}
            self.assertEqual(before, after)
            self.assertEqual(report["summary"]["datasets_with_scan_errors"], 0)
            self.assertGreaterEqual(report["summary"]["hardlink_cache_hits"], 2)
            self.assertGreaterEqual(report["summary"]["decoded_pixel_duplicate_groups"], 1)
            self.assertEqual(report["summary"]["frozen_test_eligible_samples"], 0)

            samples = {sample["sample_id"]: sample for sample in report["samples"]}
            original = samples["pairs:ring-one"]
            self.assertFalse(original["coordinate_compatible"])
            self.assertIs(original["production_exposure"], True)
            self.assertIs(original["seen_by_production"], True)
            self.assertIs(original["seen_as_dense_label"], True)
            self.assertIs(original["eligible_for_frozen_test"], False)
            self.assertEqual(original["lineage_case_key"], "ring-one")
            alpha = original["artifacts"][0]["image"]["alpha_statistics"]
            self.assertGreater(alpha["fractional_pixels"], 0)
            self.assertIs(samples["external:same-full"]["production_exposure"], "unknown")
            self.assertIs(samples["external:same-full"]["seen_by_refiner"], "unknown")
            self.assertTrue(any(
                item.get("sample_id") == "pairs:ring-incomplete"
                for item in report["untraceable_artifacts"]))
            self.assertTrue(any(
                item.get("dataset_id") == "missing"
                for item in report["untraceable_artifacts"]))
            self.assertEqual(report["run_manifests"][0]["fingerprint"],
                             "fixture-fingerprint")
            self.assertEqual(report["generator"]["sha256"],
                             sha256_file(Path(inventory.__file__)))

            self.assertTrue(output.with_suffix(".summary.md").is_file())
            expected_seal = hashlib.sha256(output.read_bytes()).hexdigest()
            self.assertEqual(output.with_suffix(".sha256").read_text().split()[0],
                             expected_seal)
            with self.assertRaises(FileExistsError):
                build_inventory(config, root, root / "trash", output)


if __name__ == "__main__":
    unittest.main()
