import cv2
import numpy as np


def square_thumb(image_rgb: np.ndarray, size: int = 256) -> np.ndarray:
    h, w = image_rgb.shape[:2]
    scale = size / max(h, w)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    resized = cv2.resize(image_rgb, (nw, nh), interpolation=cv2.INTER_AREA)
    canvas = np.full((size, size, 3), 255, dtype=np.uint8)
    yo, xo = (size - nh) // 2, (size - nw) // 2
    canvas[yo:yo + nh, xo:xo + nw] = resized
    return canvas


def write_cutout(path, image_rgb: np.ndarray, alpha: np.ndarray) -> None:
    bgra = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGRA)
    bgra[:, :, 3] = alpha
    cv2.imwrite(str(path), bgra)


def write_mask(path, mask: np.ndarray) -> None:
    cv2.imwrite(str(path), mask)


def write_wrap_mask(path, mask: np.ndarray) -> None:
    """Save a wrap mask as RGBA where alpha carries the mask (RGB white). The
    editor seeds from the alpha and the on-model renderer occludes by it."""
    h, w = mask.shape[:2]
    bgra = np.full((h, w, 4), 255, dtype=np.uint8)
    bgra[:, :, 3] = mask
    cv2.imwrite(str(path), bgra)


def write_rgb(path, image_rgb: np.ndarray) -> None:
    cv2.imwrite(str(path), cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR))
