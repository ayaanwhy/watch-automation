import json
import threading

import config

_lock = threading.Lock()


def _defaults() -> dict:
    return {"detectorUrl": config.DETECTOR_URL, "detectorToken": config.DETECTOR_TOKEN}


def load() -> dict:
    data = {}
    if config.SETTINGS_FILE.exists():
        try:
            data = json.loads(config.SETTINGS_FILE.read_text())
        except Exception:
            data = {}
    merged = _defaults()
    for key, value in data.items():
        if value is not None:
            merged[key] = value
    return merged


def save(detector_url=None, detector_token=None) -> dict:
    with _lock:
        current = load()
        if detector_url is not None:
            current["detectorUrl"] = detector_url
        if detector_token:
            current["detectorToken"] = detector_token
        config.SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.SETTINGS_FILE.write_text(json.dumps(current))
    return current


def public_view() -> dict:
    state = load()
    return {
        "detectorUrl": state.get("detectorUrl", ""),
        "hasToken": bool(state.get("detectorToken")),
        "detector": config.DETECTOR,
    }
