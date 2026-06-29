PATCHES.md

Purpose

This document records compatibility patches applied to third-party dependencies. These are not project bugs; they are upstream compatibility issues with newer Python package versions.

⸻

BasicSR 1.4.2 + TorchVision ≥ 0.16

Issue

BasicSR imports:

from torchvision.transforms.functional_tensor import rgb_to_grayscale

torchvision.transforms.functional_tensor was removed in TorchVision 0.16. The function now lives in:

from torchvision.transforms.functional import rgb_to_grayscale

Patch

File

site-packages/basicsr/data/degradations.py

Replace:

from torchvision.transforms.functional_tensor import rgb_to_grayscale

With:

from torchvision.transforms.functional import rgb_to_grayscale

Reason

Compatibility with TorchVision 0.16+ (tested with 0.27.1).

⸻

BiRefNet Checkpoint Naming

The Hugging Face repository ships:

model.safetensors

The UBG project expects:

BiRefNet_dynamic.safetensors

Action

Rename:

model.safetensors

to

BiRefNet_dynamic.safetensors

and place it in:

preprocessing/UBG/stage0/BiRefNet/

⸻

NumPy ≥ 2.0

Status

Compatibility issue currently under investigation.

Current error:

`np.float_` was removed in the NumPy 2.0 release.
Use np.float64 instead.

When resolved, document:

* affected package
* affected file
* exact patch applied

⸻

Environment Used

Verified on:

* Python 3.11
* NumPy 2.4.6
* Torch 2.12.1
* TorchVision 0.27.1
* BasicSR 1.4.2
* RealESRGAN 0.3.0

⸻

Verification

BasicSR import:

python -c "import basicsr; print('basicsr import ok')"

Runner smoke test:

python electron_runner.py \
  --input-dir <input> \
  --output-dir <output> \
  --scale-factor 1 \
  --object-type watch