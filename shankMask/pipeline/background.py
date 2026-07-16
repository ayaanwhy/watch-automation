import time

import cv2
import numpy as np
import onnxruntime as ort

INPUT_SIZE = 1024
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class BackgroundRemover:
    def __init__(self, model_path: str, device: str = "auto"):
        session = None
        if device != "cpu":
            try:
                opts = ort.SessionOptions()
                opts.enable_mem_pattern = False
                session = ort.InferenceSession(
                    str(model_path),
                    sess_options=opts,
                    providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
                )
            except Exception:
                session = None
        if session is None:
            session = ort.InferenceSession(
                str(model_path), providers=["CPUExecutionProvider"]
            )
        self.session = session
        self.input_name = session.get_inputs()[0].name
        self.output_name = session.get_outputs()[0].name

    def matte(self, image_rgb: np.ndarray) -> np.ndarray:
        h, w = image_rgb.shape[:2]
        work = image_rgb
        max_dim = 2048
        if max(h, w) > max_dim:
            scale = max_dim / max(h, w)
            work = cv2.resize(
                image_rgb,
                (int(w * scale), int(h * scale)),
                interpolation=cv2.INTER_AREA,
            )

        inp = cv2.resize(work, (INPUT_SIZE, INPUT_SIZE), interpolation=cv2.INTER_AREA)
        inp = inp.astype(np.float32) / 255.0
        inp = (inp - _MEAN) / _STD
        inp = inp.transpose(2, 0, 1)[np.newaxis]

        outputs = self.session.run([self.output_name], {self.input_name: inp})
        mask = np.asarray(outputs[0][0]).squeeze()
        del inp, outputs

        if mask.min() < 0 or mask.max() > 1:
            mask = 1.0 / (1.0 + np.exp(-mask))

        mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_CUBIC)
        mask = np.clip(mask * 255.0, 0, 255).astype(np.uint8)
        return mask
