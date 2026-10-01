#!/usr/bin/env python3
"""Install the Ring segmentation model weights into ring_segmentation/models/.

The two ONNX files (~60 MB) are not committed here — the same convention as
preprocessing/UBG/models. They are copied from a PixelForge checkout
(`<repo>/pixelForge/deploy` by default, or --source DIR) and verified against
the SHA-256 pinned below (PixelForge release v15_layer_refiner_v8_exact_e6), so
a wrong or corrupt file is never installed.

    python install_models.py            # install (or verify) from pixelForge/deploy
    python install_models.py --source /path/to/deploy
    python install_models.py --check    # verify only; exit 1 if missing/wrong

Deployments may also point RING_SEGMENTATION_MODEL_DIR at a directory holding
the two files instead of installing them here.
"""
import argparse
import hashlib
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
MODELS_DIR = HERE / "models"
PINNED_SHA256 = {
    "model.onnx": "fb44a8ca59e63cc546473d9d701ca95cac1b900c692981f395083121f125d139",
    "ownership_refiner.onnx": "803b83a64a6f13d3e1e9717c5d0a13765502f2f8b7859499b0ed86d9de2afcba",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified(path: Path, name: str) -> bool:
    return path.is_file() and sha256(path) == PINNED_SHA256[name]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=REPO_ROOT / "pixelForge" / "deploy")
    parser.add_argument("--check", action="store_true", help="only verify the installed files")
    args = parser.parse_args()

    ok = True
    for name in PINNED_SHA256:
        target = MODELS_DIR / name
        if verified(target, name):
            print(f"ok       {target}")
            continue
        if args.check:
            print(f"MISSING/INVALID {target}")
            ok = False
            continue
        source = args.source / name
        if not verified(source, name):
            print(f"error: {source} is missing or does not match the pinned SHA-256", file=sys.stderr)
            ok = False
            continue
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        print(f"installed {target}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
