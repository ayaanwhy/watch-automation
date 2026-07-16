import httpx

import settings as settings_store
from detectors import normalize
from detectors.base import DetectorAdapter, DetectorError


class PartnerHTTPDetector(DetectorAdapter):
    def _config(self):
        state = settings_store.load()
        url = (state.get("detectorUrl") or "").rstrip("/")
        token = state.get("detectorToken") or ""
        if not url:
            raise DetectorError("detector_url_missing", "Detector URL is not configured.")
        return url, token

    def _headers(self, token):
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _guard(self, response):
        if response.status_code in (401, 403):
            raise DetectorError("detector_unauthorized", "Detector rejected the token.")
        response.raise_for_status()

    def detect_models(self, items, body_type):
        url, token = self._config()
        payload = [
            {
                "name": item.get("name", ""),
                "sName": item.get("sName", ""),
                "sURL": item.get("sURL", ""),
            }
            for item in items
        ]
        with httpx.Client(timeout=90) as client:
            response = client.post(
                f"{url}/api/v1/models/coordinates",
                json=payload,
                headers=self._headers(token),
            )
        self._guard(response)
        body = response.json()
        results = body.get("results", []) if isinstance(body, dict) else (body or [])
        output = []
        for entry in results:
            output.append(
                {
                    "name": entry.get("name"),
                    "sName": entry.get("sName"),
                    "sUUID": entry.get("sUUID"),
                    "sURL": entry.get("sURL"),
                    "coords": normalize.normalize(entry, body_type),
                }
            )
        return output

    def detect_single(self, image_bytes, filename, body_type):
        url, token = self._config()
        files = {"image": (filename or "image.png", image_bytes, "application/octet-stream")}
        with httpx.Client(timeout=90) as client:
            response = client.post(
                f"{url}/api/v1/vto/coordinates",
                files=files,
                headers=self._headers(token),
            )
        self._guard(response)
        return normalize.normalize(response.json(), body_type)

    def health(self):
        url, token = self._config()
        with httpx.Client(timeout=20) as client:
            response = client.get(
                f"{url}/api/v1/healthcheck",
                headers=self._headers(token),
            )
        return response.status_code, (response.text or "")[:300]
