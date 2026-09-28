import unittest

import numpy as np

from benchmark.correction_workflow import (assign_geometry_holdout,
                                           decode_binary_mask,
                                           encode_binary_mask,
                                           select_manual_decision_cases,
                                           select_representative_cases)


FIELDS = {
    "Center stone shape": ("Round", "Oval", "Pear", "Cushion"),
    "Ring head type": ("Basket", "Crown", "Peg Head"),
    "Mounting type": ("Single", "Double", "Contemporary"),
    "Side setting": ("U-Pave", "Bead", "Channel"),
    "Side stones type": ("Diamond", "Alt. Ruby", "Alt. Sapphire"),
    "Side stones length": ("1/2", "3/4"),
    "Center stone size": ("0.25 ct", "1 ct", "10 ct"),
}


def fake_case(index, source=None):
    selected = {field: values[index % len(values)] for field, values in FIELDS.items()}
    return {
        "id": f"core-case-{index:03d}",
        "status": "ok",
        "asset_type": "ring",
        "source_sha256": source or f"sha-{index:03d}",
        "selected": selected,
        "metrics": {"back_fraction": 0.12 + (index % 20) / 100,
                    "back_components": 1 + index % 3},
        "masks": {"full": "full.png", "front": "front.png", "back": "back.png"},
    }


class CorrectionWorkflowTests(unittest.TestCase):
    def test_binary_run_round_trip(self):
        mask = np.zeros((37, 53), dtype=bool)
        mask[2:7, 4:29] = True
        mask[17, 1:52:3] = True
        mask[31:36, 39:48] = True
        runs = encode_binary_mask(mask)
        np.testing.assert_array_equal(decode_binary_mask(runs, mask.shape), mask)

    def test_binary_run_decoder_rejects_overlap_and_bounds(self):
        with self.assertRaises(ValueError):
            decode_binary_mask([[3, 5], [7, 2]], (3, 3))
        with self.assertRaises(ValueError):
            decode_binary_mask([[8, 2]], (3, 3))
        with self.assertRaises(ValueError):
            decode_binary_mask([[2, 0]], (3, 3))

    def test_representative_selection_is_exact_and_deterministic(self):
        report = {"asset_type": "ring", "cases": [fake_case(i) for i in range(90)]}
        first = select_representative_cases(report, budget=24, mandatory_ids=())
        second = select_representative_cases(report, budget=24, mandatory_ids=())
        self.assertEqual(len(first), 24)
        self.assertEqual([case["id"] for case in first],
                         [case["id"] for case in second])
        for field, values in FIELDS.items():
            self.assertEqual({case["selected"][field] for case in first}, set(values))

    def test_holdout_never_splits_source_identical_cases(self):
        cases = [fake_case(i) for i in range(12)]
        cases[1]["source_sha256"] = cases[0]["source_sha256"] = "shared-a"
        cases[7]["source_sha256"] = cases[6]["source_sha256"] = "shared-b"
        split = assign_geometry_holdout(cases, holdout_size=4)
        self.assertEqual(sum(value == "holdout" for value in split.values()), 4)
        self.assertEqual(split[cases[0]["id"]], split[cases[1]["id"]])
        self.assertEqual(split[cases[6]["id"]], split[cases[7]["id"]])

    def test_train_and_holdout_are_disjoint(self):
        cases = [fake_case(i) for i in range(20)]
        split = assign_geometry_holdout(cases, holdout_size=5)
        train = {case_id for case_id, name in split.items() if name == "train"}
        holdout = {case_id for case_id, name in split.items() if name == "holdout"}
        self.assertFalse(train & holdout)
        self.assertEqual(train | holdout, {case["id"] for case in cases})

    def test_manual_decisions_select_exact_nonapproved_cases_in_status_order(self):
        cases = [fake_case(i) for i in range(5)]
        report = {
            "snapshot_id": "snapshot-a",
            "runtime": {"signature": "runtime-a"},
            "asset_type": "ring",
            "cases": cases,
        }
        exported = {
            "snapshot": "snapshot-a",
            "runtime": "runtime-a",
            "decisions": {
                cases[0]["id"]: {"status": "approved"},
                cases[1]["id"]: {"status": "inspect"},
                cases[2]["id"]: {"status": "rejected"},
                cases[3]["id"]: {"status": "inspect"},
                cases[4]["id"]: {"status": "rejected"},
            },
        }
        selected = select_manual_decision_cases(report, exported)
        self.assertEqual(
            [case["id"] for case in selected],
            [cases[2]["id"], cases[4]["id"], cases[1]["id"], cases[3]["id"]],
        )
        self.assertEqual(
            [case["manual_review_status"] for case in selected],
            ["rejected", "rejected", "inspect", "inspect"],
        )

    def test_manual_decisions_must_match_snapshot_and_runtime(self):
        report = {
            "snapshot_id": "snapshot-a",
            "runtime": {"signature": "runtime-a"},
            "asset_type": "ring",
            "cases": [fake_case(0)],
        }
        exported = {
            "snapshot": "snapshot-b",
            "runtime": "runtime-a",
            "decisions": {},
        }
        with self.assertRaisesRegex(ValueError, "different snapshot"):
            select_manual_decision_cases(report, exported)
        exported["snapshot"] = "snapshot-a"
        exported["runtime"] = "runtime-b"
        with self.assertRaisesRegex(ValueError, "different runtime"):
            select_manual_decision_cases(report, exported)


if __name__ == "__main__":
    unittest.main()
