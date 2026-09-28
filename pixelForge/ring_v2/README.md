# Ring segmentation v2

This package contains the replacement pipeline under development. It must not change
the current `vto/` or `deploy/` runtime until the v2 candidate passes the frozen release
gates in the local `plans/ring-segmentation-v2/` programme.

## Current status

- Branch: `ring-segmentation-v2`
- Stage: 0.4 provenance inventory complete; independent labels remain pending
- Frozen Git base: `1493f4ffdeceec1ac88d3e0015faf7f25fda3cee`
- Verified local artifact: `ring_v2/artifacts/production-freeze-20260904-sealed`
- Artifact seal: `b2981ddc1acb32b93236f9a81efc293193ff244de2383185ec255a271d6bedb6`
- Production code/model changed by Stage 0.0: no

The artifact folder is deliberately ignored because it contains copied ONNX files and
smoke outputs. Its seal must be re-hashed before it is used as rollback evidence.

## Baselines that must remain separate

### Live deployment

- Provider: `CPUExecutionProvider`
- Host: Ubuntu 24.04 Azure VM, x86-64
- CPU: 4 virtual CPUs, AMD EPYC 9V74
- RAM: 15 GiB, no swap
- GPU: none
- Container: one healthy PixelForge API container
- Container image digest: `sha256:beb4da0d959ed53e12ac9f31087a394feb11908c8587e7c3339d02050134ccef`
- Runtime: Python 3.11.16; ONNX Runtime 1.29.0; OpenCV 4.11.0.86;
  NumPy 1.26.4; FastAPI 0.115.6; Uvicorn 0.34.0
- Observed container memory during capture: approximately 631 MiB
- Eight smoke requests on 2026-09-04:
  - server processing: 1,145.8–1,398.0 ms
  - caller wall time: 1,675.6–1,981.4 ms

### Frozen local benchmark/reference

- Local GPU: NVIDIA GeForce RTX 3050 Laptop GPU, 6 GiB
- Provider: `CUDAExecutionProvider` with CPU provider available for unsupported nodes
- Historical 585-case benchmark mean/median: 645.0/641.6 ms
- Current four-case freeze capture after warmup includes 660.5–1,066.4 ms server time;
  the first request includes session/warmup cost and is reported separately.

Do not call the live host a GPU deployment. Do not compare its end-to-end latency with
local CUDA model time without separating network and provider.

## Production freeze

Run from the repository root. The output directory must not already exist.

```bash
.venv/bin/python -m ring_v2.freeze_production \
  --repo . \
  --out ring_v2/artifacts/production-freeze-YYYYMMDD \
  --live-url https://pixelforge.clouddeploy.in \
  --smoke rings/editor-batch-production-585/source/core-round-4-prongs-single.jpg \
  --smoke rings/editor-batch-production-585/source/core-princess-flower-halo-double.jpg \
  --smoke rings/editor-batch-production-585/source/side-bead-alt-ruby-1-2.jpg \
  --smoke rings/editor-batch-production-585/source/extreme-marquise-basket-10-ct.jpg
```

The command:

1. copies and hashes every runtime/model file;
2. captures `/health` and two responses per smoke case from live production;
3. starts the copied runtime with CPU, captures the same requests and stops it;
4. starts the copied runtime with CUDA, captures the same requests and stops it;
5. verifies layer partitioning and rollback compatibility;
6. writes `manifest.json` and a `seal.json` containing every artifact hash.

It refuses to overwrite an existing freeze.

## Start the copied rollback runtime

The live deployment is CPU-only, so CPU is the correct rollback provider:

```bash
cd ring_v2/artifacts/production-freeze-20260904-sealed/runtime
RING_MODEL=deploy/model.onnx \
RING_OWNERSHIP_REFINER=deploy/ownership_refiner.onnx \
RING_PROVIDER=CPUExecutionProvider \
PYTHONPATH=. \
../../../../.venv/bin/python -m uvicorn deploy.serve:app \
  --host 127.0.0.1 --port 8201 --workers 1
```

Check it without changing the production service:

```bash
curl -fsS http://127.0.0.1:8201/health
curl -fsS -F \
  'file=@../smoke/sources/core-round-4-prongs-single.jpg' \
  http://127.0.0.1:8201/segment > /tmp/jewelsense-rollback-smoke.json
```

The freeze utility already performed this startup and response comparison automatically.

## Known production defect: request nondeterminism

Repeated identical production requests change a small number of boundary pixels. The
same behavior occurs in the copied CPU and CUDA runtimes. A controlled test showed that
calling `cv2.setRNGSeed(0)` before every segmentation makes repeated arrays identical,
which points to mutable OpenCV RNG state in the GrabCut contour-refinement path.

The freeze therefore distinguishes:

- **exact determinism**, required for v2;
- **rollback compatibility**, used only to preserve the current stochastic production
  baseline: restore tight crops to source coordinates, compare visible premultiplied
  RGBA, require stable non-crop metadata, at most 0.25% changed pixels and at most
  0.10/255 mean absolute channel error. Raw PNG hashes remain recorded separately.

The final freeze passed with a worst live-to-rollback visible changed-pixel fraction of
0.05020% and worst mean absolute channel error of 0.02213/255. All layer partitions
reconstructed exactly.

Do not patch the deployed v1 code to reset the RNG during this project: that would
change the production reference. V2 must remove or deterministically replace the
unsafe operation and pass exact repeated-request hashes.

## Independent editor agreement set

The 40-case source-only workspace is local and ignored by Git:

```text
rings/editor-agreement-40-v1/
  source/                         40 canonical 1000px source JPGs
  editor-a/returned/              first independent editor's output
  editor-b/returned/              second independent editor's output
  contact-sheet-source-only.jpg
  manifest.json
```

The cases have 40 unique source hashes. The two lanes use different randomized orders,
and no model prediction is present. Editors must return the exact two RGBA filenames
documented in each lane's `README.md`; they must not see one another's labels.

This source universe is narrower than production: it has upright configurator renders
on a clean white plate, not verified real-shadow, tilted/side-view, bypass/open-ended or
three-stone examples. `manifest.json` records that limitation. Those missing buckets
need a supplementary native-source set before v2 can make broad release claims.

Audit a lane while work is incomplete:

```bash
.venv/bin/python -m ring_v2.labels.audit \
  --manifest rings/editor-agreement-40-v1/manifest.json \
  --returned rings/editor-agreement-40-v1/editor-a/returned \
  --out rings/editor-agreement-40-v1/editor-a/audit-YYYYMMDD \
  --allow-missing
```

For a final audit, omit `--allow-missing`. Invalid labels are quarantined; the auditor
never resizes, aligns or repairs them. Run the same command for editor B, then compare
two complete audits:

```bash
.venv/bin/python -m ring_v2.labels.compare_agreement \
  --editor-a-audit rings/editor-agreement-40-v1/editor-a/audit-YYYYMMDD \
  --editor-b-audit rings/editor-agreement-40-v1/editor-b/audit-YYYYMMDD \
  --out rings/editor-agreement-40-v1/agreement-YYYYMMDD
```

The comparison writes native-resolution metrics, source/editor disagreement previews,
an HTML review page and an adjudication template. Training stays blocked until both
lanes pass, disagreements are adjudicated, and the label contract is versioned.

## Dataset and production-exposure inventory

The Stage 0.4 scanner is read-only. It inventories source and target hashes, decoded
pixel hashes, dimensions, alpha/mask coverage, target-canvas compatibility, provenance,
production exposure, exact duplicates, correction exports, archives and historical run
metadata. It does not admit any sample into training, validation or frozen test.

Run it from the repository root. The output path must not already exist:

```bash
.venv/bin/python -m ring_v2.data.inventory \
  --config ring_v2/config/inventory.json \
  --repo . \
  --out data/ring-v2/inventory-v1.json
```

The generated JSON, Markdown summary and SHA-256 sidecar live under ignored `data/`.
Verify the report from its own directory so the relative filename in the sidecar resolves:

```bash
(cd data/ring-v2 && sha256sum -c inventory-v1.sha256)
```

The sealed 2026-09-04 inventory contains:

- 34 present dataset roots and no scan failures;
- 16,923 dataset occurrences representing 10,989 source identities;
- 335 historical run/model/evaluation/correction manifests with no parse failures;
- 9,754 occurrences linked to deployed training or checkpoint selection;
- 7,169 occurrences whose production exposure remains unknown, never assumed clean;
- 32 incomplete legacy pair occurrences: 16 recovered cases and their Trash mirrors;
- two undecodable external earring files, unrelated to ring segmentation truth;
- 1,412 coordinate-incompatible labelled occurrences, including all ten legacy
  `rings/edited` triples;
- zero samples automatically eligible for frozen test.

Most importantly, all 585 configurator sources and all 40 agreement copies were used by
the deployed layer refiner lineage. They remain useful for training, diagnostic and
agreement work, but they cannot become an unseen frozen test. Stage 0.5 must form design
groups and obtain a separate clean test source universe before any release claim.

Current report SHA-256:
`d6688409c783f94fc2927a1a58c91dcb962a3e40e4227c20b3652e2a17454d63`.

## Tests

```bash
.venv/bin/python -m pytest -q tests/test_ring_v2_freeze.py
.venv/bin/python -m pytest -q tests/test_ring_v2_prepare_agreement.py \
  tests/test_ring_v2_label_audit.py
.venv/bin/python -m pytest -q tests/test_ring_v2_inventory.py
```

The freeze code uses only the runtime dependencies already required by deployment.
