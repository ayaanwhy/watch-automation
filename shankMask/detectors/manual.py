from detectors.base import DetectorAdapter


class ManualDetector(DetectorAdapter):
    def detect_models(self, items, body_type):
        return [
            {
                "name": item.get("name"),
                "sName": item.get("sName"),
                "sUUID": None,
                "sURL": item.get("sURL"),
                "coords": None,
            }
            for item in items
        ]

    def detect_single(self, image_bytes, filename, body_type):
        return None

    def health(self):
        return 200, "manual"
