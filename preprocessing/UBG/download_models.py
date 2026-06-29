from __future__ import annotations

import shutil
import urllib.request
from pathlib import Path


SAM2_TINY_URL = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
TARGET = Path("models/sam2/sam2.1_hiera_tiny.pt")
LOCAL_CANDIDATES = (
    Path(r"C:\Users\Bebop\ComfyUI-Installs\Bebop\ComfyUI\models\sam2\sam2.1_hiera_tiny.pt"),
)


def download_sam2() -> Path:
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    if TARGET.exists():
        print(f"SAM 2 checkpoint already exists: {TARGET}")
        return TARGET

    for candidate in LOCAL_CANDIDATES:
        if candidate.exists():
            shutil.copy2(candidate, TARGET)
            print(f"Copied SAM 2 checkpoint from: {candidate}")
            return TARGET

    print("Downloading official SAM 2.1 tiny checkpoint...")
    with urllib.request.urlopen(SAM2_TINY_URL) as response, TARGET.open("wb") as file_obj:
        shutil.copyfileobj(response, file_obj)
    print(f"Downloaded SAM 2 checkpoint: {TARGET}")
    return TARGET


if __name__ == "__main__":
    download_sam2()
