import tempfile
import unittest
from pathlib import Path

from benchmark.build_manual_review import browser_relative_path


class ManualReviewTests(unittest.TestCase):
    def test_source_path_is_relative_to_nested_review_directory(self):
        with tempfile.TemporaryDirectory() as root:
            project = Path(root)
            output = (project / "benchmark" / "results" / "retest" /
                      "snapshot" / "runtime")
            source = (project / "benchmark" / "snapshots" / "snapshot" /
                      "images" / "ring.jpg")
            output.mkdir(parents=True)
            source.parent.mkdir(parents=True)
            source.touch()

            self.assertEqual(
                browser_relative_path(source, output),
                "../../../../snapshots/snapshot/images/ring.jpg",
            )


if __name__ == "__main__":
    unittest.main()
