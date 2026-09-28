# JewelSense Ring Segmentation API

Production package for the JewelSense v15 ring and gemstone segmentation
pipeline. It keeps the proven v13 base model and adds a learned four-class
final-layer refiner that can remove matte pixels and correct front/back
ownership. The FastAPI service serves both the JSON/PNG API and the browser
testing frontend from the same origin.

## Included

- `deploy/model.onnx` — unchanged v13 production base model
- `deploy/ownership_refiner.onnx` — v15 learned final-layer residual
- `deploy/serve.py` — API and image post-processing
- `deploy/web/index.html` — upload and layer-inspection frontend
- `vto/post.py` — deterministic edge cleanup and front/back partitioning
- `benchmark/` and `vto/` — reproducible benchmark and fine-tuning code
- `tests/` — inference, post-processing, and data-contract regressions
- CPU and NVIDIA GPU Docker images with pinned runtime requirements

Large training datasets, source snapshots, generated benchmark results, ring
images, and intermediate checkpoints are intentionally Git-ignored. The code
needed to collect snapshots, materialize future corrections, fine-tune, export,
benchmark, and review a replacement model remains in the repository.

## Run with Docker

The CPU service can be started from the repository root:

```bash
docker compose up --build -d
```

Open `http://localhost:8200/` for the testing frontend. Health and model
metadata are available at `http://localhost:8200/health`.

For an NVIDIA GPU deployment, registry publishing, reverse-proxy guidance,
health verification, and rollback instructions, read [DEPLOYMENT.md](DEPLOYMENT.md).

## API

Frontend request/response types, compositing order, browser examples, and
error handling are documented in [FRONTEND_API.md](FRONTEND_API.md).

- `POST /segment` — ring segmentation as base64 `full`, `front`, and `back`
  PNG layers plus dimensions, timing, and review metadata.
- `POST /segment/full` — full ring cutout as a transparent PNG.
- `POST /segment/front` — front ring layer as a transparent PNG.
- `POST /segment/back` — rear band layer as a transparent PNG.
- `POST /segment-gem` — loose gemstone cutout on a 500px-wide physical-scale
  transparent canvas; accepts `width` and `height` in millimetres.

Example:

```bash
curl -F 'file=@ring.jpg' http://localhost:8200/segment/front --output front.png
```

Product imagery should ideally be at least 1000×1000. The network input is
384×384. Ring PNGs are trimmed to their encoded alpha bounds; ring full, front,
and back layers always share one crop, and `/segment` returns that crop's
offset within the uploaded image. Gemstones are tightly segmented, physically
scaled from the supplied dimensions, and centred horizontally on a 500px-wide
transparent VTO canvas. Its top and bottom are trimmed. The network itself
still runs at 384×384.
Legacy previews below 1000px are processed on a bounded 1000px working raster
with a conservative, model-led matte cleanup. Their outer alpha is
area-downsampled for subpixel coverage, while front/back ownership is reduced
as a hard majority class so the internal seam cannot appear in both layers as
a floating hairline. Native 1000px inputs keep the reviewed correction path.

## Runtime configuration

The container defaults to CPU inference. Important environment variables:

- `RING_PROVIDER` — ONNX Runtime execution provider.
- `RING_THREADS` — CPU inference threads; default `4`.
- `RING_MODEL` — model path; default `deploy/model.onnx`.
- `RING_OWNERSHIP_REFINER` — ownership-refiner path; default
  `deploy/ownership_refiner.onnx`. Set it to an empty value only to disable
  the refiner intentionally.
- `RING_REFINER_CLASS_THRESHOLDS` — optional
  `to_background,to_front,to_back` override. The deployed ONNX embeds the
  validated `0.90,0.93,0.95` values, so ordinary runs should leave this unset.
- `RING_LAYER_REFINER_RESIZE` — optional `probability` or `discrete` override.
  The deployed ONNX embeds the validated `probability` mode.
- `RING_MIN_REFINER_ACTION_COMPONENT` — optional native action-component
  cutoff. The deployed ONNX embeds the validated value `0`.
- `RING_RECOMMENDED_INPUT` — low-resolution warning threshold; default `1000`.
- `RING_PROCESSING_MIN_SIZE` — internal working size for smaller ring previews;
  default `1000`. Set to `0` to disable low-resolution supersampling.
- `RING_PROCESSING_MAX_SIZE` — upper bound for either working dimension;
  default `1600`.
- `RING_LOW_RES_BACK_EXPAND` — ownership expansion used only by the
  supersampled compatibility path; default `1`. Native 1000px inference keeps
  the trained `RING_BACK_EXPAND=1` contract.
- `RING_LOW_RES_MIN_FRONT_COMPONENT` — encoded-PNG component cutoff for
  detached low-resolution seam dashes; default `64`. It does not affect the
  native 1000px reviewed-correction path.
- `RING_LOW_RES_MIN_BACK_COMPONENT` — minimum low-resolution rear detail area;
  default `64`. Smaller isolated predictions are reassigned to front, while a
  repeated aligned halo/prong row is retained as intentional rear geometry.
- `GEM_CONTOUR_EPSILON` — subpixel loose-gem contour simplification in pixels;
  default `1.2`. It removes model-raster stair steps while retaining cut tips
  and corners.
- `GEM_CONTOUR_SUPERSAMPLE` — loose-gem contour rendering scale; default `8`.
  Rendering is bounded internally for large uploads.
- `GEM_CANVAS_PX` / `GEM_CANVAS_MM` — physical gemstone canvas width;
  defaults to `500` pixels representing `20` mm. Output height follows the
  resized gemstone.
- `GEM_MAX_DIMENSION_MM` — largest accepted gemstone width or height; defaults
  to the canvas size in millimetres.
- `GEM_DEFAULT_WIDTH_MM` / `GEM_DEFAULT_HEIGHT_MM` — gemstone dimensions used
  only when the request omits both values; both default to `10` mm.

The remaining cleanup thresholds exposed by `/health` can also be overridden
through their matching `RING_*` environment variables in `deploy/serve.py`.

## Model provenance

- Release: `v15_layer_refiner_v8_exact_e6`, with the v13 base unchanged
- Base ONNX SHA-256: `fb44a8ca59e63cc546473d9d701ca95cac1b900c692981f395083121f125d139`
- Refiner ONNX SHA-256: `803b83a64a6f13d3e1e9717c5d0a13765502f2f8b7859499b0ed86d9de2afcba`
- Training checkpoint SHA-256:
  `3c33d8a4d7f56a8059cc76d9c124f306d05d91bb2574d2e38dc6c662cffa1ce6`
- Refiner ONNX/PyTorch maximum absolute parity error: `1.013279e-05`
- Full GPU gate: 585/585 available cases succeeded, zero review flags and
  zero errors. Against 72 reviewed native targets, 54 improve, 18 tie, and
  none regress; total full/front/back binary error falls from 132,290 to
  60,226 pixels. Among 513 non-correction cases, one center ownership pixel
  changes and no full silhouette changes.

PyTorch checkpoints are recorded for provenance but are not required at
runtime. Local checkpoints remain ignored because the deployable ONNX files
are the production artifacts.
