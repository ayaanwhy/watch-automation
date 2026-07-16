import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def _list(name: str, default: str) -> list:
    return [v.strip() for v in os.environ.get(name, default).split(",") if v.strip()]


STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", str(BASE_DIR / "storage")))
PRODUCTS_DIR = STORAGE_DIR / "products" / "_processed"
MODELS_DIR = STORAGE_DIR / "models"
SETTINGS_FILE = STORAGE_DIR / "settings.json"

BIREFNET_MODEL = os.environ.get(
    "BIREFNET_MODEL", str(BASE_DIR / "models" / "birefnet_lite_fp16.onnx")
)
GPU_DEVICE = os.environ.get("GPU_DEVICE", "auto")

# Background-removal model selection. "birefnet" (default) or "ben2". Additional
# backends register in pipeline/matting.py.
BG_MODEL = os.environ.get("BG_MODEL", "birefnet")
BEN2_MODEL = os.environ.get("BEN2_MODEL", "PramaLLC/BEN2")
BEN2_DEVICE = os.environ.get("BEN2_DEVICE", "auto")
BEN2_REFINE = os.environ.get("BEN2_REFINE", "0").strip().lower() in ("1", "true", "yes")
# Matte-shaping for BEN2: it produces a tighter/softer edge falloff than BiRefNet,
# so thin/soft edges can fall under the shared binary threshold and look "over-cut".
# GAMMA < 1.0 lifts the soft edge band (keeps more); DILATE grows the kept region
# by N px. Both default to a no-op so behaviour is unchanged unless tuned.
BEN2_MATTE_GAMMA = float(os.environ.get("BEN2_MATTE_GAMMA", "1.0"))
BEN2_MATTE_DILATE = int(os.environ.get("BEN2_MATTE_DILATE", "0"))
# Product uploads larger than this are scaled down before cutout. Very large studio
# images are less stable for matting/cleanup and are unnecessary for on-model VTO.
MAX_PRODUCT_DIM = int(os.environ.get("MAX_PRODUCT_DIM", "2400"))

# Optional segmentation support for hard studio jewellery cutouts.
SEG_MODEL = os.environ.get("SEG_MODEL", "sam_hq")
SEG_DEVICE = os.environ.get("SEG_DEVICE", "auto")
SEG_MAX_DIM = int(os.environ.get("SEG_MAX_DIM", "1600"))
SAM_HQ_CHECKPOINT = os.environ.get("SAM_HQ_CHECKPOINT", str(BASE_DIR / "models" / "sam_hq_vit_b.pth"))
SAM_HQ_MODEL_TYPE = os.environ.get("SAM_HQ_MODEL_TYPE", "vit_b")

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8100"))

PUBLIC_ASSETS_URL = os.environ.get("PUBLIC_ASSETS_URL", f"http://localhost:{PORT}")
CORS_ORIGINS = _list("CORS_ORIGINS", "*")

DETECTOR = os.environ.get("DETECTOR", "partner_http")
DETECTOR_URL = os.environ.get("DETECTOR_URL", "")
DETECTOR_TOKEN = os.environ.get("DETECTOR_TOKEN", "")

BODY_TYPES = ["wrist", "finger", "neck", "ear"]


def ensure_dirs():
    PRODUCTS_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
