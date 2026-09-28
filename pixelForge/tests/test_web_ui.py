import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB_UI = ROOT / "deploy" / "web" / "index.html"


class IdCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()

    def handle_starttag(self, _tag, attrs):
        values = dict(attrs)
        if values.get("id"):
            self.ids.add(values["id"])


class WebUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = WEB_UI.read_text(encoding="utf-8")
        parser = IdCollector()
        parser.feed(cls.html)
        cls.ids = parser.ids

    def test_required_upload_and_layer_controls_exist(self):
        self.assertTrue({
            "file-input", "drop-zone", "segment-button", "mode-ring",
            "mode-gem", "image-original", "image-full", "image-front",
            "image-back", "zoom-range",
        }.issubset(self.ids))

    def test_frontend_uses_existing_ring_and_gemstone_endpoints(self):
        self.assertIn('fetch("/segment?compact=1"', self.html)
        self.assertIn('fetch("/segment-gem"', self.html)
        self.assertIn('fetch("/health"', self.html)

    def test_frontend_reconstructs_compact_ring_layers(self):
        self.assertIn("result.front_mask", self.html)
        self.assertIn("result.back_mask", self.html)
        self.assertIn('globalCompositeOperation = "destination-in"',
                      self.html)

    def test_ui_is_packaged_in_container(self):
        dockerfile = (ROOT / "deploy" / "Dockerfile").read_text(
            encoding="utf-8")
        self.assertIn("COPY --chown=jewelsense:jewelsense deploy /app/deploy",
                      dockerfile)


if __name__ == "__main__":
    unittest.main()
