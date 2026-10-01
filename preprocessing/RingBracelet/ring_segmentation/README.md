# Ring segmentation (PixelForge-derived)

Replaces the shank-mask CV step **for Rings only** in `../runner.py`
(`--product ring`). Bracelets still use `../shank_mask.py`, unchanged; the model
is never imported for them.

## What it does in our pipeline

```
preprocessing output (background-removed RGBA)
   ├─► SKU;frontFullImage.png   = that image, unmodified
   └─► front_ownership.generate_ring_model_mask()
          composite on flat white (+ margin) → PixelForge ring model
          → which pixels are the hidden REAR band  (mask, 255 = rear)
       alpha × (1 − mask) → shadow step (unchanged) → SKU;frontImage.png
```

`frontImage` therefore keeps the preprocessing silhouette and dimensions; only the
front/rear-band decision comes from the model. **No background removal runs here** —
PixelForge's ring path has none (its ring matte is a model output), and the input is
already background-removed.

## Files

| File | Origin |
| --- | --- |
| `front_ownership.py` | ours — adapter, error tokens, white composite, mask contract |
| `pixelforge_ring.py` | extracted from `pixelForge/deploy/serve.py` (ring path only: `_forward`, `_predict_crop`, `_clean_alpha`, `_refine_final_ownership`, `_segment_native`, `_ring_processing_shape`, `segment`) |
| `pixelforge_post.py` | verbatim subset of `pixelForge/vto/post.py` (functions the ring path reaches) |
| `models/model.onnx`, `models/ownership_refiner.onnx` | PixelForge release `v15_layer_refiner_v8_exact_e6` (git-ignored; `install_models.py`) |

Intentionally **not** taken: FastAPI service, web frontend, gemstone endpoint, training/benchmark/VTO code,
Dockerfiles, the `back` layer as an output (used internally only), and PixelForge's RGB decontamination.

## Runtime

Python ≥ 3.9 with `onnxruntime`, `numpy`, `opencv` (see `requirements.txt`); CPU inference
(~1–4 s per image, < 1 GB RAM). Models resolve from `models/` next to this file, or from
`$RING_SEGMENTATION_MODEL_DIR`. Failures carry a `[RING_SEGMENTATION_<KIND>]` token
(`MODEL_UNAVAILABLE`, `RUNTIME_ERROR`, `INFERENCE_FAILED`, `OUTPUT_MISSING`, `OUTPUT_INVALID`) which the
automation engine turns into structured errors.
