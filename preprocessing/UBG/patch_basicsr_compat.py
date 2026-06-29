#!/usr/bin/env python3
"""
patch_basicsr_compat.py

One-time compatibility patch for BasicSR 1.4.2 under TorchVision 0.16+.

Root cause: basicsr/data/degradations.py imports rgb_to_grayscale from
torchvision.transforms.functional_tensor, a private submodule removed in
TorchVision 0.16.0. The function still exists at the public path
torchvision.transforms.functional.rgb_to_grayscale with an identical API.

Run this script once after installing or reinstalling BasicSR:
    python patch_basicsr_compat.py
"""
import sys
from pathlib import Path

OLD_IMPORT = "from torchvision.transforms.functional_tensor import rgb_to_grayscale"
NEW_IMPORT = "from torchvision.transforms.functional import rgb_to_grayscale"


def main() -> int:
    try:
        import basicsr
    except ImportError:
        print("basicsr is not installed — nothing to patch.")
        return 0

    target = Path(basicsr.__file__).parent / "data" / "degradations.py"

    if not target.exists():
        print(f"Expected file not found: {target}")
        print("BasicSR package layout may have changed — skipping patch.")
        return 0

    source = target.read_text(encoding="utf-8")

    if OLD_IMPORT not in source:
        if NEW_IMPORT in source:
            print("basicsr/data/degradations.py is already patched — nothing to do.")
        else:
            print("Unexpected content in basicsr/data/degradations.py — skipping patch.")
            print(f"(Could not find '{OLD_IMPORT}')")
        return 0

    patched = source.replace(OLD_IMPORT, NEW_IMPORT, 1)
    target.write_text(patched, encoding="utf-8")
    print(f"Patched: {target}")
    print("BasicSR is now compatible with TorchVision 0.16+.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
