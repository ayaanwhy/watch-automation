# Buchroeders configurator benchmark

This benchmark makes live-configurator testing reproducible across future model
fine-tunes. It stores the exact source bytes and SHA-256 for every available
configuration. Model results are stored separately under a signature derived
from the ONNX graph, deployment metadata, post-processing code and `RING_*` /
`GEM_*` settings.

The collector is read-only: it changes controls in a headless browser and
downloads the vendor's maximum native 1000px preview. The configurator displays
499px by default, but that version produces visibly soft edges when enlarged;
the same public endpoint accepts `s=1000`. It does not select a setting, add to
cart, or call the JewelSense server. Use `--image-size 499` only when reproducing
an older low-resolution snapshot.

## One-time browser setup

```bash
cd benchmark
npm install
npx playwright install chromium
cd ..
```

## Smoke test

```bash
node benchmark/collect.mjs \
  --suite benchmark/suites/smoke-v1.json \
  --snapshot-id buchroeders-smoke-YYYYMMDD

.venv/bin/python -m vto.configurator_benchmark run \
  --snapshot benchmark/snapshots/buchroeders-smoke-YYYYMMDD \
  --model deploy/model.onnx
```

A snapshot ID is immutable. Reusing it fails instead of overwriting evidence.
A failed or unavailable source case is retained in `manifest.json`.

## Ultimate suite

Regenerate the deterministic 606-case suite if its generator changes:

```bash
.venv/bin/python benchmark/generate_suite.py
```

The suite contains:

- all 7 center shapes × 7 enabled heads × 9 mountings (441 cases);
- minimum/maximum stones for every shape/head (98);
- side setting × colour × length coverage plus `None` (41);
- 16 head/mounting metal-colour pairs;
- 7 natural-diamond integration checks;
- 3 curated high-risk designs.

Run it slowly against the public configurator and keep the source snapshot:

```bash
node benchmark/collect.mjs \
  --suite benchmark/suites/ultimate-v1.json \
  --snapshot-id buchroeders-ultimate-v1-YYYYMMDD \
  --image-size 1000 \
  --delay-ms 750

.venv/bin/python -m vto.configurator_benchmark run \
  --snapshot benchmark/snapshots/buchroeders-ultimate-v1-YYYYMMDD
```

To require GPU execution, install the CUDA build of ONNX Runtime and set the
provider explicitly. The run fails instead of silently falling back to CPU:

```bash
RING_PROVIDER=CUDAExecutionProvider \
python -m vto.configurator_benchmark run \
  --snapshot benchmark/snapshots/buchroeders-ultimate-v1-YYYYMMDD \
  --model deploy/model.onnx
```

Unavailable vendor combinations are recorded and skipped; network/collector
errors remain failures. Each successful model case saves full/front/back alpha
masks, integrity metrics, configuration metadata and a dark-background review.

## Manual review (no server)

Build a standalone viewer after a benchmark run:

```bash
.venv/bin/python benchmark/build_manual_review.py \
  --report benchmark/results/SNAPSHOT/RUNTIME/report.json \
  --snapshot benchmark/snapshots/SNAPSHOT
```

Open the generated `manual_review.html` directly in a browser. It starts with
the highest-risk cases and keeps the source, full mask, front layer and back
layer in one full-screen workspace: four columns on wide screens, a 2×2 grid
on medium screens and panel tabs on phones. Use Fit/−/+ or the slider for up to
4x zoom; each panel pans independently without scrolling the page. Dark,
checkerboard and white backgrounds are available. Use `A`, `I` and `R` to
approve, mark for inspection or reject; decisions stay in browser local
storage and can be exported as JSON. No JewelSense or local HTTP server is
started.

The generated `manual_priority_*.jpg` files are compact contact sheets for a
quick first pass. The risk score only prioritizes human review; it is not an
automatic quality verdict.

## Local gemstone regression set

Loose, single-gemstone product images use the same model matte but intentionally
skip ring front/back classification (`front = full`, `back = empty`). Freeze the
exact source bytes before a fine-tune so the new model can be compared later:

```bash
.venv/bin/python benchmark/snapshot_local_images.py rings/gems \
  --snapshot-id jewelsense-gems-YYYYMMDD \
  --asset-type gemstone

.venv/bin/python -m vto.configurator_benchmark run \
  --snapshot benchmark/snapshots/jewelsense-gems-YYYYMMDD \
  --model deploy/model.onnx
```

The snapshot is immutable and content-addressed just like the configurator
snapshot. `mask_touches_canvas` remains a review warning for tightly cropped
gemstone sources: segmentation cannot restore a facet or tip that is outside
the supplied raster.

## Compare a future fine-tune

Run the same immutable source snapshot with the new ONNX artifact, then compare
the two `report.json` files:

```bash
.venv/bin/python -m vto.configurator_benchmark compare \
  --baseline benchmark/results/SNAPSHOT/OLD_RUNTIME/report.json \
  --candidate benchmark/results/SNAPSHOT/NEW_RUNTIME/report.json \
  --out benchmark/results/SNAPSHOT/comparison.json
```

The comparison checks source hashes and reports full/front/back binary IoU,
changed pixel counts and mean alpha changes for every case.

For an offline, change-only visual review, generate marked before/after sheets:

```bash
.venv/bin/python benchmark/build_layer_comparison.py \
  --baseline benchmark/results/SNAPSHOT/OLD_RUNTIME/report.json \
  --candidate benchmark/results/SNAPSHOT/NEW_RUNTIME/report.json \
  --snapshot benchmark/snapshots/SNAPSHOT
```

Open `layer_comparison_review.html` directly. Red boxes mark the changed area in
the baseline back layer and green boxes mark it in the candidate. The generated
JSON preserves exact per-case changed-pixel counts and coordinates.

## What must be preserved

Preserve `benchmark/snapshots/` and each result `report.json` plus its `masks/`
in durable local or object storage. The raw source images are content-addressed,
so identical renders within a snapshot are stored only once. These large,
generated evidence folders are Git-ignored in the deployment repository; the
suite definitions and all runner/review code are versioned.
