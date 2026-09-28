# Product validator

This folder is an independent ring/gemstone validation project. It does not
import, modify or overwrite the production segmentation model, refiner,
post-processing code or API.

The validator has five outputs:

- product type: `ring`, `gemstone`, `other`
- camera view: `front`, `side`, `angled`, `rear`
- orientation correction: `none`, `rotate_left`, `rotate_right`, `half_turn`
- segmentation suitability: yes/no
- quality flags: multiple products, occlusion, cropping, low quality,
  and lifestyle photography

At runtime those predictions produce one of four decisions: accepted,
correctable, rejected or uncertain. A correctable image is a front camera view
that becomes upright after the returned rotation operation. Only a calibrated
high-confidence failure may become a hard API error. Borderline inputs remain
uncertain.

## Review guide

All current manual queues are generated from
`product_validator/data/review_ready_manifest.json`. Do not regenerate one
queue from a different manifest: exports can only be combined when their
manifest fingerprints match.

Open `product_validator/review/index.html` to review every unresolved image in
one queue. The source-specific pages are available when you prefer shorter
sessions; decisions are shared between them in the same browser because all
pages carry the same fingerprint.

The one-click buttons save immediately and open the next unreviewed image:

- **Front · Use**: valid and already upright.
- **Rotate left/right to fix**: valid front camera view, but the entire image
  needs the named correction. “Right” means 90° clockwise; “left” means 90°
  counter-clockwise. The vertical ring with its setting on the left should be
  marked **Rotate right to fix**.
- **Half-turn to fix**: valid front camera view, upside down.
- **Angled / Side / Rear · Reject**: camera pose is unsuitable; these are not
  canvas-rotation labels.
- The remaining reject buttons record the visible failure reason.

Shortcuts are printed on every button. In particular, `Q` rotates left, `E`
rotates right, `H` is a half-turn, and Backspace undoes the last decision.
Rotated valid products remain suitable because the correction is applied
before segmentation.

## Current data status

The repository contains a useful positive seed set, but it does not contain
enough reviewed side/rear views, loose gemstones or unrelated products to train
a safe rejection model. The training command deliberately refuses incomplete
data unless the developer uses an explicit research-only override.

The deleted training data was recovered to
`product_validator/data/recovered_20260902/`. It remains ignored by Git. The
1,200 ring-only `pairs` products are included as front-facing positives. Only
their complete `full.png` image is used; the ownership-layer `front.png` target
is deliberately excluded. The 448 Talla rings keep their known product label
but require manual review of view and suitability. A second recovered subset contains 147 cached inputs
with generation metadata: 91 single-gem positives, 36 multi-gem failures and 20
ring inputs. Cache entries without metadata are excluded.

Build and audit the initial manifest from the repository root:

```bash
python -m product_validator.manifest seed
python -m product_validator.manifest audit \
  --manifest product_validator/data/seed_manifest.json
```

The audit exits with status 2 until every minimum class count is met. That is
expected at the beginning of data collection.

Build the Talla review page and open it in a browser:

```bash
python -m product_validator.review \
  --manifest product_validator/data/seed_manifest.json \
  --source recovered_talla_pairs

python -m product_validator.review \
  --manifest product_validator/data/seed_manifest.json \
  --asset gemstone \
  --output product_validator/review/gemstones.html

xdg-open product_validator/review/index.html
```

If the browser blocks local image files, serve the repository root instead:

```bash
python -m http.server 8090
```

Then open `http://localhost:8090/product_validator/review/index.html`.

The page stores work in the browser and downloads a JSON file when **Export
decisions** is clicked. Apply that export to a new manifest:

```bash
python -m product_validator.apply_labels \
  --manifest product_validator/data/seed_manifest.json \
  --decisions /path/to/talla-decisions.json \
  --decisions /path/to/gemstone-decisions.json \
  --output product_validator/data/reviewed_manifest.json
```

### Tanishq multi-view ring review

The Tanishq collector accepts an explicit list of public product pages and
downloads each product's gallery as one group. It does not crawl search,
account, cart or checkout endpoints. Downloaded images and provenance stay in
the ignored validator data directory.

```bash
.venv/bin/python -m product_validator.collectors.tanishq \
  --url-file product_validator/sources/tanishq_rings.txt

.venv/bin/python -m product_validator.import_folder \
  --manifest product_validator/data/reviewed_manifest.json \
  --folder product_validator/data/external/tanishq_rings \
  --source tanishq_product_gallery \
  --asset ring --view unknown --rotation unknown \
  --suitable unknown --quality unknown \
  --group-by parent \
  --output product_validator/data/tanishq_review_manifest.json

.venv/bin/python -m product_validator.review \
  --manifest product_validator/data/review_ready_manifest.json \
  --source tanishq_product_gallery \
  --output product_validator/review/tanishq-rings.html
```

The product type is already set to **Ring**. For each image, label the camera
view and whether it is usable by the current VTO segmentation pipeline. Keep
all images for one product under the same product directory so group-safe
train/validation splitting cannot leak alternate views of a product.

The source images are not committed. Their provenance file also carries a
reminder to confirm reuse rights before distributing the images or a model
derived from them.

### Licensed gemstone candidates

The Commons collector uses the official MediaWiki API and retains the source,
license and attribution for every file. By default it admits only CC0,
public-domain and CC BY images; ShareAlike and unclear licenses are skipped.
The selected categories contain both valid single loose gems and useful
failures such as groups, jewellery and diagrams, so their product type and
suitability must be reviewed.

```bash
.venv/bin/python -m product_validator.collectors.commons \
  --category-file product_validator/sources/commons_gem_categories.txt \
  --max-files 200 --delay 1.0

.venv/bin/python -m product_validator.import_folder \
  --manifest product_validator/data/tanishq_review_manifest.json \
  --folder product_validator/data/external/commons_gems \
  --source wikimedia_commons_faceted_gems \
  --asset unknown --view unknown --rotation unknown \
  --suitable unknown --quality unknown \
  --group-by parent \
  --output product_validator/data/external_review_manifest.json

.venv/bin/python -m product_validator.review \
  --manifest product_validator/data/review_ready_manifest.json \
  --source wikimedia_commons_faceted_gems \
  --output product_validator/review/commons-gems.html
```

### Permission-cleared jewellery dataset

The project owner confirmed permission to use
`sidd707/jewelry-design-dataset`. The pinned revision and archive checksum are
recorded in `sources/hf_sidd707_jewelry_design.json`. The dataset contains 233
ring candidates and 5,924 bracelet, earring and necklace images. The latter
are useful `other` negatives. The ring folder is not clean enough to label by
directory alone: it includes alternate views, multiple rings and at least one
non-ring item, so it must go through manual review.

Download the pinned archive, verify its checksum and extract it below the
ignored validator data directory. Then import the ring candidates with unknown
labels and import each non-ring directory as an unsuitable `other` class. Use
`--group-by hash`; byte-identical files are skipped by the importer and cannot
land on both sides of the train/validation split.

```bash
curl -L --fail \
  https://huggingface.co/datasets/sidd707/jewelry-design-dataset/resolve/57a3f0389d55f3d42f4637a76a773bbd64514f37/dataset.zip \
  -o product_validator/data/external/hf_jewelry_design/dataset.zip

sha256sum -c - <<'EOF'
efa16ab76505bcb3302e628ce2bc680d6bbc4f3dd6d6a2edfe96ee8cb0312940  product_validator/data/external/hf_jewelry_design/dataset.zip
EOF

unzip product_validator/data/external/hf_jewelry_design/dataset.zip \
  -d product_validator/data/external/hf_jewelry_design/files

.venv/bin/python -m product_validator.import_folder \
  --manifest product_validator/data/reviewed_manifest.json \
  --folder product_validator/data/external/hf_jewelry_design/files/dataset/ring_best \
  --source hf_sidd707_ring_candidates \
  --asset unknown --view unknown --rotation unknown \
  --suitable unknown --quality unknown \
  --group-by hash \
  --output product_validator/data/hf_ring_review_manifest.json

.venv/bin/python -m product_validator.review \
  --manifest product_validator/data/review_ready_manifest.json \
  --source hf_sidd707_ring_candidates \
  --output product_validator/review/hf-ring-candidates.html
```

The generated review page for the ring subset is
`product_validator/review/hf-ring-candidates.html`. Review product type, view,
suitability and quality before training.

To add another collection, place it below `product_validator/data/` and import
it. The arguments are labels for every image in that folder, so use `unknown`
when the folder is mixed and review it in the browser afterward.

```bash
python -m product_validator.import_folder \
  --manifest product_validator/data/reviewed_manifest.json \
  --folder product_validator/data/imports/invalid-products \
  --source merchant-invalid-202609 \
  --asset other --view unknown --rotation unknown \
  --suitable no --quality none \
  --output product_validator/data/with-negatives.json
```

## Isolation contract

- Training artifacts stay under `product_validator/runs/`.
- ONNX candidates stay under `product_validator/exports/`.
- No export command writes into `deploy/`.
- The existing API is not changed until a validator passes the holdout,
  calibration and latency gates and is explicitly approved for integration.

## Planned workflow

1. Build the seed manifest.
2. Add real merchant negatives and alternate views.
3. Review labels in the generated browser tool.
4. Train the standalone MobileNetV3 validator.
5. Calibrate thresholds and inspect false rejections.
6. Export and benchmark the standalone ONNX model.
7. Run it in shadow mode before considering API enforcement.

Training stays blocked until the manifest passes the audit. Once it does:

```bash
python -m product_validator.train \
  --manifest product_validator/data/with-negatives.json

python -m product_validator.evaluate \
  --checkpoint product_validator/runs/RUN_ID/best.pt \
  --manifest product_validator/data/with-negatives.json

python -m product_validator.export \
  --checkpoint product_validator/runs/RUN_ID/best.pt

python -m product_validator.benchmark \
  --model product_validator/exports/product_validator.onnx \
  --manifest product_validator/data/with-negatives.json
```

`--allow-incomplete-data` exists only for code smoke tests. A model created with
that override is not a production candidate.

Splitting keeps every observed label represented in training. Labels found in
only one product group stay in training, so the validation fraction can be
smaller than requested. If no nonempty validation split is possible without
losing a training label, add independent product groups before training.
The ONNX benchmark reports incorrect rotation operations separately and counts
them as unsafe acceptances, even when the predicted status is `correctable`.

The final production optimization can later distill these labels into a shared
encoder, but that work is intentionally outside the current segmentation model.

The measurable release requirements are in [ACCEPTANCE.md](ACCEPTANCE.md).
`python -m product_validator.isolation` verifies that both production ONNX
files still match the baseline recorded before this work began.
