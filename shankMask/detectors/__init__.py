import config
from detectors.base import DetectorAdapter, DetectorError
from detectors.manual import ManualDetector
from detectors.partner_http import PartnerHTTPDetector


def get_detector() -> DetectorAdapter:
    if config.DETECTOR == "manual":
        return ManualDetector()
    return PartnerHTTPDetector()


__all__ = ["get_detector", "DetectorAdapter", "DetectorError"]
