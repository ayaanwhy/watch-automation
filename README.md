# Watch Processing Automation

Electron desktop application for automating product-photo post-processing for jewelry/watch e-commerce assets: background removal, upscaling, edge refinement, shadow generation, and per-product finishing (Ring/Bracelet mask baking, Earring stud/drop/hoop, Watch dial-boundary annotation + compositing). Output is production-ready transparent PNG "frontImage" assets, tracked through a local batch registry with a review/QA workflow.

Internal codename in code comments: "Atelier" (UI design language) / "VTO Automation" (window title). Package name: `watch-processing-automation`.

This is a **local desktop tool for a human operator**, not a web service. There is no server component and nothing to "host" in the traditional sense — see [How the application is expected to be hosted/deployed](#how-the-application-is-expected-to-be-hosteddeployed).

---

## Table of contents

1. [High-level architecture](#high-level-architecture)
2. [Tech stack](#tech-stack)
3. [Repository structure](#repository-structure)
4. [Prerequisites](#prerequisites)
5. [Installation / setup](#installation--setup)
6. [Dependencies](#dependencies)
7. [Environment variables and configuration](#environment-variables-and-configuration)
8. [External services / APIs](#external-services--apis)
9. [Running locally](#running-locally)
10. [Build / packaging](#build--packaging)
11. [How the application is expected to be hosted/deployed](#how-the-application-is-expected-to-be-hosteddeployed)
12. [Backend/API requirements](#backendapi-requirements)
13. [Python runtime requirements](#python-runtime-requirements)
14. [Data/storage requirements](#datastorage-requirements)
15. [Ports/network requirements](#portsnetwork-requirements)
16. [Production configuration](#production-configuration)
17. [Health checks, logging, troubleshooting](#health-checks-logging-troubleshooting)
18. [Security considerations](#security-considerations)
19. [Known limitations / blockers](#known-limitations--blockers)
20. [Deployment Readiness Summary](#deployment-readiness-summary)

---

## High-level architecture

Three layers, no network boundary between any of them — everything runs on one machine:

```
┌─────────────────────────────────────────────────────────────┐
│ Electron renderer (Chromium)                                 │
│ React + TypeScript UI — apps/desktop/src                     │
│ Konva canvas for Watch dial-boundary annotation               │
└───────────────────────────┬────────────────────────────────┘
                             │ contextBridge IPC (ipcRenderer.invoke/on)
┌───────────────────────────▼────────────────────────────────┐
│ Electron main process (Node.js)                              │
│ apps/desktop/electron — IPC handlers, batch registry,         │
│ session persistence, prefs, Python subprocess orchestration   │
└───────────────────────────┬────────────────────────────────┘
                             │ spawns, NDJSON over stdout/stdin
┌───────────────────────────▼────────────────────────────────┐
│ Python subprocesses (one per pipeline run, CLI-invoked)        │
│ preprocessing/ — BiRefNet background removal, SAM 2            │
│ segmentation, Real-ESRGAN upscaling, per-product masking       │
└─────────────────────────────────────────────────────────────┘
```

A fourth piece, `packages/processing` (TypeScript, no Python), implements the Watch product's own image splice/scale/shadow compositing directly in Node — it does not go through the Python pipeline. It's consumed both by the Electron app and by a standalone CLI (`src/cli/processWatch.ts`).

There is no database and no HTTP server anywhere in this system. All persistent state is flat JSON files on disk (see [Data/storage requirements](#datastorage-requirements)).

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 33 |
| Renderer UI | React 18, TypeScript, `electron-vite` (Vite-based build) |
| Canvas/annotation | Konva / react-konva |
| Shared processing library | TypeScript (`packages/processing`), `sharp` (image I/O), `xlsx` (spreadsheet parsing) |
| Heavy CV pipeline | Python 3 subprocess: PyTorch, BiRefNet (background removal), SAM 2 (segmentation), Real-ESRGAN/BasicSR (upscaling), OpenCV |
| Testing | Vitest (TypeScript), some tests also spawn the real Python pipeline |
| Package management | npm workspaces (`packages/*`, `apps/*`) |

## Repository structure

```
.
├── apps/desktop/            Electron application (the actual product)
│   ├── electron/            Main process: IPC handlers, services, logger
│   │   ├── ipc/              One handler module per feature area
│   │   └── services/          batchRegistry, pythonResolver, subprocessRunner, ...
│   └── src/                 Renderer (React UI)
│       ├── components/, screens/, context/, hooks/, constants/, types/
├── packages/processing/     @wpa/processing — TS library: Watch splice/scale/
│                             shadow compositing, spreadsheet/SKU matching
├── preprocessing/           Python pipeline (invoked as subprocesses)
│   ├── UBG/                  "Universal" pipeline: BiRefNet + SAM2 + upscaling
│   │   ├── models/             Model weights (gitignored, provisioned separately)
│   │   ├── stage0/BiRefNet/    Background-removal model + weights
│   │   ├── services/           SAM segmenter, upscaler, plugin loader
│   │   └── plugins/            Per-product mask plugins (ring/bracelet/earring/watch/generic)
│   ├── RingBracelet/          Ring & Bracelet mask baking + shadow
│   ├── Earring/               Earring (stud/drop/hoop) masking + shadow
│   ├── shadow.py              Shared drop-shadow compositor (ports packages/processing's algorithm)
│   └── runner_base.py         Shared NDJSON subprocess protocol
├── src/cli/processWatch.ts  Standalone CLI wrapper around packages/processing
├── scripts/                 Benchmark scripts (dev-only)
├── tests/                   Vitest suite (root-level, covers all workspaces)
├── sampledata/               Currently empty — see Known limitations
├── PROJECT_SPEC.md, IMPLEMENTATION_PLAN.md, PROJECT_BRIEF.md
│                             Historical design/planning docs (not deployment docs)
└── package.json              Root workspace — orchestrates the two npm packages
```

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js | Not pinned in the repo (no `engines` field, no `.nvmrc`). Electron 33 bundles Node ~20.18. `@types/node` targets `^22.10.1`. **Recommend Node 20 or 22.** |
| npm | Used for workspace install (`workspaces` field in root `package.json`). Version not pinned. |
| Python | **Not pinned in the repo.** Evidence in `__pycache__` shows the pipeline has been run under 3.10, 3.11, and 3.12 at different times. **TBD: confirm and pin an exact version before deploying.** |
| OS | Developed/tested on macOS (Apple Silicon — MPS GPU paths) and Windows (paths referenced in `preprocessing/UBG/download_models.py`). No Linux-specific evidence found; see [Known limitations](#known-limitations--blockers). |
| GPU | Optional. CUDA → Apple MPS → CPU fallback is implemented for every model (BiRefNet, SAM 2, Real-ESRGAN). CPU works but is slow for ML inference. |
| Disk space | Model weights alone are ~570 MB (see [Python runtime requirements](#python-runtime-requirements)); the PyTorch/CUDA toolchain is several GB. Budget accordingly — exact figure TBD. |

## Installation / setup

Run in order, from the repo root:

```bash
# 1. Install Node dependencies for all workspaces
npm install

# 2. Build the shared TypeScript processing library
#    (apps/desktop depends on packages/processing's compiled output)
npm run build:packages

# 3. Set up the Python environment (separate from Node — see below)
#    Create/activate a Python environment (conda recommended — see
#    "Python interpreter discovery"), then:
pip install -r preprocessing/UBG/requirements.txt

# 4. One-time BasicSR/TorchVision compatibility patch (required — see
#    "Known limitations")
python preprocessing/UBG/patch_basicsr_compat.py

# 5. Fetch the SAM 2 checkpoint (~149 MB, downloads from Meta's public URL)
python preprocessing/UBG/download_models.py

# 6. Provide the BiRefNet weights manually — NOT automated, see
#    "Known limitations": place BiRefNet_dynamic.safetensors at
#    preprocessing/UBG/stage0/BiRefNet/BiRefNet_dynamic.safetensors
```

Then verify:

```bash
cd apps/desktop && npx electron-vite dev
```

### Python interpreter discovery

The app does **not** read a configured Python path by default — it auto-discovers a working interpreter at runtime (`apps/desktop/electron/services/pythonResolver.ts`), in this order:

1. `$CONDA_PREFIX` (active Conda environment) — macOS: `bin/python3`, Windows: `python.exe`
2. `~/miniconda3`, `~/miniforge3`, `~/anaconda3` (standard install locations)
3. `which python3` / `where python` (PATH fallback)

Each candidate is validated by running `import torch, sam2, basicsr` in it; the first one that succeeds is cached for the process lifetime. There is also a manual override field in the app's Settings screen, persisted to `prefs`. **There is no environment variable to preset this** — see [Environment variables and configuration](#environment-variables-and-configuration).

## Dependencies

### Node (npm workspaces)

| Package | Where | Purpose |
|---|---|---|
| `react`, `react-dom` | apps/desktop | UI |
| `electron`, `electron-vite` | apps/desktop | Desktop shell + build tooling |
| `konva`, `react-konva` | apps/desktop | Annotation canvas |
| `@wpa/processing` (workspace) | apps/desktop | Watch image compositing (built separately, see setup) |
| `sharp` | root, apps/desktop | Native image I/O (prebuilt binary per-platform via npm) |
| `xlsx` | packages/processing | Spreadsheet (SKU sheet) parsing |
| `lucide-react` | apps/desktop | Icon set |
| `commander`, `tsx` | root | CLI tooling (`src/cli/processWatch.ts`) |
| `vitest` | root | Test runner |

Full versions: see each `package.json` (root, `apps/desktop`, `packages/processing`) and `package-lock.json`.

### Python

See [Python runtime requirements](#python-runtime-requirements). Dependency list lives at `preprocessing/UBG/requirements.txt` — this repo's existing, working manifest (verified against every `import` in `preprocessing/`); **no separate root-level `requirements.txt` was added** to avoid two divergent copies of the same list. See the note at the end of this document.

## Environment variables and configuration

**No `.env` file is read anywhere in the codebase** (`.env`/`.env.local` are gitignored but nothing in the app loads them). Configuration is handled two ways:

| Mechanism | Scope | Details |
|---|---|---|
| `$CONDA_PREFIX` | Optional, ambient | Only used opportunistically during Python interpreter auto-discovery (see above). Not required. |
| In-app "prefs" (JSON files) | User/runtime config | Written by the app itself to Electron's `userData` directory as the user interacts with Settings (Python override, folder history, presets, shadow profiles, appearance). Not meant to be hand-edited or pre-seeded by DevOps. See [Data/storage requirements](#datastorage-requirements). |

There are **no required environment variables** for the app to start. `ELECTRON_RENDERER_URL` appears in `main.ts` but is set automatically by `electron-vite dev` itself (dev-mode HMR server URL) — it is not user-facing configuration.

**No secrets, API keys, or credentials are used anywhere in the current codebase.**

## External services / APIs

**None are integrated today.** The application is fully offline/local at runtime.

A planned integration exists in the design docs (`IMPLEMENTATION_PLAN.md`, "Phase 14") for an AI dial-boundary-detection endpoint (`watchdialcoord.clouddeploy.in`) to assist Watch annotation. As of the latest investigation recorded in that document, **the endpoint is not deployed** (probing every plausible path returns a stock Apache default-install page, self-signed TLS cert, no application behind the reverse proxy). No client code for this exists in the repository — it was explicitly halted before implementation. Treat this as **not applicable to the current handoff**.

The only outbound network calls the *setup process* makes are one-time, manual, and not part of app runtime:
- `python preprocessing/UBG/download_models.py` fetches the SAM 2 checkpoint from `dl.fbaipublicfiles.com`.
- `pip install -r preprocessing/UBG/requirements.txt` installs `sam-2` directly from a GitHub URL (`git+https://github.com/facebookresearch/sam2.git`) — outbound access to GitHub is required at install time.

## Running locally

```bash
cd apps/desktop
npx electron-vite dev
```

Opens the Electron window with Vite HMR for the renderer. Requires steps 1–6 in [Installation / setup](#installation--setup) to already be done (Node deps installed, `@wpa/processing` built, Python environment ready with model weights in place) for any product's actual processing pipeline to succeed — the window itself will open without them, but jobs will fail at the Python-resolution or model-load step.

Other useful root-level commands:

```bash
npm test                        # vitest run — full test suite (see caveats below)
npm run process:watch           # CLI-only Watch processing (no Electron UI)
npm run build                   # tsc --noEmit — typecheck only, no output
npm run benchmark               # dev-only profiling script
```

## Build / packaging

```bash
cd apps/desktop
npx electron-vite build
```

Produces `apps/desktop/out/` — bundled main/preload/renderer JavaScript. **This is not a distributable installer.** There is no `electron-builder`, `electron-forge`, or equivalent packaging configuration anywhere in the repository — no `.dmg`/`.exe`/`.AppImage` is produced. See [Known limitations](#known-limitations--blockers).

`packages/processing` has its own build (`tsup`, invoked via `npm run build:packages` from root) that must run before `apps/desktop` can build or run, since it depends on the compiled `dist/index.cjs`.

## How the application is expected to be hosted/deployed

This is a **desktop GUI application operated by a human**, not a service to host. There is no server process, no listening HTTP port, and no way to run it "headless" today — the annotation workflow specifically requires interactive canvas input (dragging boundary guides).

Practical deployment today means: **installing it on a workstation** (or a machine with a display an operator can access, e.g. remote desktop/VNC) with the prerequisites above satisfied, and running it from source via the commands in [Running locally](#running-locally) — since no packaged installer exists yet.

**A hard architectural constraint to be aware of before attempting any repackaging:** the Electron main process locates the Python scripts via a path computed as `app.getAppPath() + '../../preprocessing/<...>'` (see e.g. `apps/desktop/electron/ipc/preprocessHandlers.ts`). This assumes the app is running from within the full monorepo checkout, with `preprocessing/` sitting two directories above `apps/desktop`. **This path resolution has not been adapted for a packaged/installed app** (there's no packaging config to have adapted it in). Moving to a real installer will require either bundling `preprocessing/` alongside the packaged app at that exact relative location, or changing the path-resolution logic — this is application-code work, not a deployment config, and is out of scope for this handoff document. Flagged here as a blocker, not solved.

## Backend/API requirements

None. There is no HTTP/REST/GraphQL backend anywhere in this system. The closest analog is the Python subprocess protocol: the Electron main process spawns a Python script per job (e.g. `preprocessing/UBG/electron_runner.py`, `preprocessing/RingBracelet/runner.py`) and communicates over the child process's stdio:

- **stdout**: one JSON object per line (NDJSON) — progress/completion events.
- **stdin**: a single-line JSON command (`{"cmd":"cancel"}`) for cooperative cancellation.
- **Exit codes**: `0` all succeeded, `1` fatal/zero succeeded, `2` partial success, `3` cancelled.

This protocol is internal to the app (`preprocessing/runner_base.py` implements the shared shell); it is not a public API and nothing external calls into it.

## Python runtime requirements

Dependency manifest: **`preprocessing/UBG/requirements.txt`** (already in the repo, verified against every Python import in `preprocessing/`).

```
torch
torchvision
transformers
safetensors
pillow
numpy
einops
timm
kornia
realesrgan
basicsr
opencv-python
sam-2 @ git+https://github.com/facebookresearch/sam2.git
```

None of these are version-pinned in the repo. `psutil` is imported but wrapped in `try/except ImportError` (optional, memory-profiling only — not required).

**Required one-time steps after `pip install`:**

| Step | Command | Why |
|---|---|---|
| BasicSR/TorchVision compatibility patch | `python preprocessing/UBG/patch_basicsr_compat.py` | BasicSR 1.4.2 imports a private TorchVision submodule removed in TorchVision 0.16+; this patches BasicSR's installed copy in place. Documented in the script itself. |
| SAM 2 checkpoint download | `python preprocessing/UBG/download_models.py` | Downloads `sam2.1_hiera_tiny.pt` (~149 MB) to `preprocessing/UBG/models/sam2/`. |
| BiRefNet weights | **Manual — no script.** | Place `BiRefNet_dynamic.safetensors` (~424 MB) at `preprocessing/UBG/stage0/BiRefNet/`. Source/provenance not documented in the repo — **TBD: confirm with the original developer where this file comes from.** |

**Model weight files (both gitignored, not in version control):**

| File | Size | Path |
|---|---|---|
| SAM 2.1 Hiera Tiny checkpoint | ~149 MB | `preprocessing/UBG/models/sam2/sam2.1_hiera_tiny.pt` |
| BiRefNet dynamic weights | ~424 MB | `preprocessing/UBG/stage0/BiRefNet/BiRefNet_dynamic.safetensors` |

GPU: CUDA → Apple MPS → CPU auto-detected and selected per-run, consistently across BiRefNet, SAM 2, and Real-ESRGAN (`torch.cuda.is_available()` → `torch.backends.mps.is_available()` → CPU). No manual device configuration needed or exposed.

Other Python subdirectories (`preprocessing/RingBracelet/`, `preprocessing/Earring/`, `preprocessing/shadow.py`) only require `pillow`, `numpy`, and the standard library — no additional packages beyond what's already listed.

## Data/storage requirements

**No database.** All application state is flat JSON files under Electron's `userData` directory (`app.getPath('userData')` — platform-specific, e.g. `~/Library/Application Support/<app name>` on macOS, `%APPDATA%\<app name>` on Windows):

| File(s) | Contents |
|---|---|
| `batches/index.json`, `batches/<id>.json` | Batch registry — the app's primary data model |
| `sessions/*.json` | Watch annotation session state (resumable) |
| `logs/wpa-<date>.log` | Application logs (NDJSON, see [Logging](#health-checks-logging-troubleshooting)) |
| `preprocessing-preset-definitions.json`, `shadow-profile-definitions.json` | Versioned, user-editable pipeline configuration |
| Several other single-purpose prefs files | Folder history, Python override, appearance settings, etc. |

**Batch input/output**: each batch's source images and export folders are arbitrary filesystem paths chosen per-batch by the operator via native file dialogs — not fixed, not configured centrally, not cloud storage. Whatever machine runs the app needs local (or locally-mounted) filesystem access to those folders.

No S3/blob storage, no external database, no message queue anywhere in this system.

## Ports/network requirements

**No ports are opened in production.** This is not a network service.

In `npx electron-vite dev` (development only), Vite runs its own HMR dev server on a local port (default 5173, standard Vite behavior — not explicitly configured in `electron.vite.config.ts`, so **TBD/confirm actual port at dev-server startup** if this matters for a sandboxed dev environment).

No inbound network access is required at any point. Outbound access is needed only during one-time setup (see [External services / APIs](#external-services--apis)) — not at runtime.

## Production configuration

**None exists today.** There is no environment-based config system (no `NODE_ENV`-driven branching beyond Vite/electron-vite's own dev-vs-build tooling), no feature flags, no remote config, no code signing or auto-update setup found in the repository.

If the DevOps team needs any of the following, they are **not currently implemented** and would need to be built: code signing, auto-update, crash reporting, telemetry, remote configuration, multi-environment (staging/prod) config separation.

## Health checks, logging, troubleshooting

**Logging**: `apps/desktop/electron/logger.ts` — structured NDJSON, one line per entry (`timestamp`, `level`, `message`, optional `error`/`stack`/context), written to `<userData>/logs/wpa-YYYY-MM-DD.log`. One file per day, 14-day retention (auto-pruned on app startup). **No in-app log viewer** — inspect the files directly. Not intended for end-operator consumption, developer/support diagnostics only (per the code's own comment).

**Health checks**: none exist — no `/health` endpoint (there's no server), no built-in self-test on startup beyond the Python interpreter auto-discovery/validation described above, which surfaces its result in the Settings screen (not a machine-readable health signal).

**Known test-suite caveats** (relevant to CI/DevOps, not just local dev):

| Issue | Detail |
|---|---|
| Hardcoded Python path | `tests/earringRunnerIntegration.test.ts`, `tests/shadowEngineRegression.test.ts`, `tests/subprocessRunnerIncrementalPersistence.test.ts` all hardcode `/Users/apple/miniconda3/bin/python` — **will fail on any other machine**, including CI, unless that exact path exists or the constant is changed. |
| Missing sample fixture | `tests/knownGoodProcessing.test.ts` expects `sampledata/TH1710451W.png`, which is not present (removed from the repo per git history) — this test fails on a fresh clone regardless of Python setup. |
| Root `tsconfig.json` vs. `apps/desktop/tsconfig.json` | The root-level `tsconfig.json` (stricter `NodeNext` module resolution) fails on several pre-existing test files if run directly; the project's actual typecheck gate is `apps/desktop/tsconfig.json`. Not a runtime issue, but avoid assuming `npx tsc --noEmit` from the repo root is a clean signal. |

Expect `npm test` to show 1–4 known failures out of the box until the above are addressed; this is pre-existing repo state, not something introduced by this handoff.

## Security considerations

| Area | Current state |
|---|---|
| `webSecurity` | Explicitly disabled (`webPreferences.webSecurity: false` in `main.ts`) — allows the renderer to load local `file://` images without CORS restriction, which the app relies on for previewing arbitrary local files. Acceptable *only* because the app never loads remote/untrusted web content — there is no `loadURL` to an external origin in production. |
| `sandbox` | Explicitly disabled (`sandbox: false`). |
| `contextIsolation` / `nodeIntegration` | Not explicitly set — inherit Electron's secure-by-default values (`contextIsolation: true`, `nodeIntegration: false`) for Electron 33. |
| Preload/IPC bridge | `contextBridge.exposeInMainWorld('api', {invoke, on})` — a generic pass-through to any IPC channel name, with **no channel allowlist** in the preload script itself. Safe today because the renderer only ever runs first-party, repo-controlled code (no remote content, no plugin system) — would need hardening if that ever changes. |
| Secrets/credentials | None found anywhere in the codebase. No auth system — the app assumes a single trusted local operator. |
| Network attack surface | None at runtime — no listening ports, no outbound calls (see above). |

None of the above were introduced or changed for this handoff — they reflect the app's existing configuration as found.

## Known limitations / blockers

1. **No distributable installer.** No `electron-builder`/`electron-forge` config exists. Running the app means running it from a full source checkout with `electron-vite dev`/`build`, not installing a packaged app.
2. **Packaging is architecturally blocked**, not just unconfigured: the fixed relative-path assumption between `apps/desktop` and `preprocessing/` (see [Hosting](#how-the-application-is-expected-to-be-hosteddeployed)) needs a code change before a real installer would even locate the Python pipeline correctly.
3. **BiRefNet weight file has no documented source or download automation** — must be manually obtained; provenance is unknown from the repo alone.
4. **No Python version pin.** Evidence of 3.10/3.11/3.12 all having been used at different points. Confirm and lock a version before standing up a reproducible environment.
5. **Test suite has a hardcoded developer-machine path** in three files — breaks on any other machine/CI until fixed.
6. **Missing sample data fixture** — one test always fails on a fresh clone.
7. **This is a GUI-only application** — no headless/batch/server mode. Watch annotation specifically requires interactive human input.
8. **Phase 14 (AI-assisted annotation) is not implemented** — the intended external inference endpoint is not deployed; no risk here, just noting it's design-doc-only, not partially-built code to account for.
9. **No packaged auto-update, code signing, or crash reporting** — would all be net-new work if required.

---

## Deployment Readiness Summary

**1. What can be deployed immediately**
The application can be run **from source** on a workstation today: `npm install` → `npm run build:packages` → `electron-vite dev` (or `build`, for a bundled-but-not-installable output). No code changes are required for this path. It cannot currently be handed to an end user as a double-click installer.

**2. Infrastructure/configuration the DevOps team needs to provide**
- A workstation-class machine with a display (or remote-desktop access) — not a headless server.
- Node.js (recommend 20 or 22) and npm.
- A Python 3.x environment (version TBD/to be confirmed) with `preprocessing/UBG/requirements.txt` installed, the BasicSR patch applied, the SAM 2 checkpoint downloaded, and the BiRefNet weights sourced and placed manually.
- ~1 GB+ free disk for model weights, plus several GB for the PyTorch/CUDA toolchain.
- (Optional) An NVIDIA GPU with CUDA, or Apple Silicon, for acceptable ML inference speed — CPU works but is slow.

**3. External services that must be available**
None required at runtime. GitHub and `dl.fbaipublicfiles.com` must be reachable during the one-time setup step only (installing `sam-2` from GitHub, downloading the SAM 2 checkpoint).

**4. Unresolved blockers or decisions**
- No installer/packaging strategy decided or configured (electron-builder vs. electron-forge vs. something else — TBD).
- BiRefNet weight file sourcing is undocumented — needs to come from the original developer.
- Exact Python version to standardize on is unconfirmed.
- Whether the hardcoded test Python path should be fixed/parameterized before this is wired into CI.
- Whether `preprocessing/` needs to be bundled into a packaged app, or the app is intentionally always run from a full monorepo checkout in its target environment — needs a product decision before packaging work starts.

**5. Exact commands for a clean setup → run → build flow**

```bash
# Setup
npm install
npm run build:packages
pip install -r preprocessing/UBG/requirements.txt
python preprocessing/UBG/patch_basicsr_compat.py
python preprocessing/UBG/download_models.py
# + manually place BiRefNet_dynamic.safetensors at
#   preprocessing/UBG/stage0/BiRefNet/BiRefNet_dynamic.safetensors

# Run (development)
cd apps/desktop
npx electron-vite dev

# Build (bundled output, not an installer)
cd apps/desktop
npx electron-vite build   # output: apps/desktop/out/

# Test
npm test   # from repo root — see "Known test-suite caveats" for expected pre-existing failures
```

---

*A note on `requirements.txt`: this handoff intentionally did not add a new root-level `requirements.txt`. One already exists and is correct at `preprocessing/UBG/requirements.txt` (verified against every Python import in the pipeline during this audit) — duplicating it at the root would create two manifests that can silently drift out of sync. Install from that path, as shown above.*
