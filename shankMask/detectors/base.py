class DetectorError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class DetectorAdapter:
    def detect_models(self, items: list, body_type: str) -> list:
        raise NotImplementedError

    def detect_single(self, image_bytes: bytes, filename: str, body_type: str):
        raise NotImplementedError
