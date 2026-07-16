# WatchAutomation — Project Brief

> **Status:** Living document. Update this brief whenever architecture, workflows, or roadmap priorities change — it should never fall meaningfully behind the codebase.
> **Companion documents:** `PROJECT_SPEC.md` (original product spec — processing math, canvas geometry, Boundary Provider design), `IMPLEMENTATION_PLAN.md` (phase-by-phase delivery plan), `CLAUDE.md` (binding development rules for this repo). This brief does not replace any of them — it explains how they fit together and captures context that lives only in the codebase and git history.

---

## Overview

**WatchAutomation (WPA — Watch Processing Automation Tool)** is a local-first Electron desktop application that automates the preparation of watch product imagery for a Virtual Try-On (VTO) platform.

**Who it is built for:** an internal production/operations team that today does this work by hand in Photoshop — repetitive resizing, repositioning, strap compression, and drop-shadow work across large photo batches. The tool exists to eliminate that manual labor at scale (current batches: 10–20 images; near-term target: 500; longer-term target: 2,000–3,000).

**The production workflow it solves:** turning raw watch photography — potentially still on a studio background, arbitrarily sized and positioned — into standardized, VTO-ready transparent PNG assets, where every watch's dial is scaled to its true physical measurement (from a spreadsheet) and centered on an identical 2000×2000 canvas with a consistent drop shadow.

**Design philosophy:**
- **UI and processing engine are strictly independent.** The core processing math (`packages/processing`) has zero dependency on React or Electron, specifically so it can migrate to a server-side "Sandbox" environment later with minimal change (an explicit requirement in `PROJECT_SPEC.md`).
- **Boundary detection and image processing are separate systems.** The processing engine only ever consumes `leftBoundary`/`rightBoundary` numbers — it doesn't know or care whether a human dragged a guide or an AI model predicted them. This is the single most important architectural seam in the whole application, and it is what makes the AI roadmap (Phase 12) additive rather than disruptive.
- **One phase at a time, with an explicit approval ritual.** Every phase in this project's history (and every phase for the foreseeable future) follows: propose architecture → list files → identify risks → wait for approval → implement → explain what was built/how to test/assumptions → stop. This is not a suggestion; it's a binding rule in `CLAUDE.md` and has been followed without exception throughout this project's development.
- **Production logic, once proven, is frozen unless explicitly reopened.** The Phase 0 processing engine has not been touched since it was built and verified — all subsequent work has been additive (new modules, new UI, new preprocessing capability) specifically so the mathematically-verified core never regresses.
- **Guide, don't constrain.** The application should guide users toward the correct workflow without unnecessarily restricting experienced users. Passive cues — sensible defaults, badges, inline helper text, gentle nudges — are preferred over hard gates and interrupting dialogs wherever a nudge suffices; the happy path is made obvious, but power users are never boxed in.
- **Preprocessing is product-agnostic; asset generation is product-specific.** Preprocessing performs generic preparation work — upscaling, background removal, trimming, and similar — with no knowledge of what product it's preparing imagery for. Each supported product type (Watch today; Ring and Bracelet arriving in Phase 10, Earring in Phase 13) owns its own downstream asset-generation workflow and reuses this shared preprocessing foundation rather than duplicating it. This is the same category-agnostic principle the Python plugin system already follows (see Plugin architecture below), now stated as the application's long-term architectural direction rather than as an implementation detail of one module.
- **Architecture Strengthening is a recurring activity, not a one-time phase.** Starting with Phase 11 ("Run 1"), the roadmap revisits performance, robustness, and architecture cleanup after each major product-capability expansion, rather than treating backend hardening as a single phase to check off once and never revisit.

**Long-term vision:** a pipeline that goes from raw photography to a finished VTO asset with progressively less manual intervention for Watch annotation — first fully manual (today), then AI-assisted with mandatory human review (Phase 12) — without ever having to rewrite the processing engine or the UI shell to get there. Confidence-gated, fully automated annotation remains a plausible further step but is not currently a scheduled roadmap phase. Separately, the same "processing engine that doesn't rewrite" principle is what lets the product line grow sideways (Ring, Bracelet, Earring) rather than only forward along the automation axis — see Roadmap and Design philosophy above.

---

## High-Level Workflow

WatchAutomation currently supports three end-to-end workflows, reachable from a single Module Selector screen.

### 1. Watch Processing (the original, core workflow)

**User journey:**
1. From the Module Selector, choose **Watch Processing**.
2. On **Batch Setup ("New Batch")**, pick an Input Folder (PNGs named `SKU.png`), a measurement Spreadsheet (XLSX/CSV with `sku`/`width`/`height`/`measure by` columns), and an Output Folder.
3. Click **Validate** — the app checks all three paths exist and are the right type, then loads and matches the spreadsheet against the discovered images, reporting matched SKUs, missing images, missing spreadsheet records, and any duplicate SKUs on either side.
4. If a prior session exists for this exact input+spreadsheet combination, the user is offered **Resume** (continue exactly where they left off) or **Start fresh**.
5. Click **Begin Annotation** to enter the **Annotation Workspace** — a per-SKU loop: an image canvas with draggable boundary guides, an info panel showing SKU/measurements/progress/keyboard hints, and a live processing queue sidebar.
6. For each watch, the user positions guides (Uniform or Free mode; arrow-key nudging), then clicks **Submit** — this saves the boundaries, immediately enqueues background processing for that SKU, and advances to the next unannotated watch. Processing happens asynchronously so annotation is never blocked waiting for exports.
7. The **Batch Dashboard** ("Overview") gives a filterable/sortable/searchable table of every SKU's annotation and processing status, with click-to-jump navigation back into the annotation flow.
8. Session state (which SKUs are annotated, their boundaries, queue status) autosaves continuously, so the app can be closed and reopened mid-batch without losing progress.

### 2. Preprocessing (the newer, independent module)

**User journey:**
1. From the Module Selector, choose **Preprocessing**.
2. Pick an Input Folder (raw product photos) and Output Folder (both persisted across app restarts).
3. Choose an **Upscale Factor** (1×/2×/4×, via a custom stepped slider) and a **Product Type** (Watch/Bracelet/Ring/Generic).
4. Optionally open **Settings** (⚙) to tune SAM2 segmentation parameters for benchmarking/quality trade-offs.
5. Click **Start** — a Python subprocess runs each image through upscaling (optional), background removal, automatic segmentation, and a category-specific plugin, streaming live progress (current image, current stage, elapsed time, a heartbeat so long stages don't look frozen).
6. The user can **Cancel** at any time — cancellation is cooperative (never a forced kill), so it always waits for a safe point between pipeline stages, never interrupting GPU work mid-kernel.
7. On completion, a summary shows succeeded/failed/cancelled counts and total runtime.

### 3. Preprocessing → Watch Processing hand-off

**User journey:**
1. After a successful (or partially successful) Preprocessing run, the completion summary shows a secondary action: **"Continue to Watch Processing →"**.
2. Clicking it triggers a **Workflow Preparation** step — every processed image is trimmed to its non-transparent content and rotated 90° counter-clockwise into a new `<output folder> - WatchReady` folder, with a live "Preparing… (n/total)" indicator so large batches don't appear frozen. The original Preprocessing output folder is never modified.
3. On success, the app navigates directly into Watch Processing's Batch Setup screen, with the prepared folder already populated as the **Input Folder** (a "Prepared ✓" badge and a short helper message make this transfer visible), and the Spreadsheet and Output Folder fields deliberately left empty — Preprocessing has no concept of spreadsheets, so the user always starts a genuinely new Watch Processing session, choosing only the two fields Preprocessing can't know about.
4. If preparation fails (e.g., no valid images, unwritable destination), the user stays on the Preprocessing summary with a clear inline error — navigation only ever happens on success.

---

## Current Architecture

### Electron
The **main process** owns every capability the renderer cannot safely have: filesystem access, spawning the Python subprocess, running `sharp` (a native image-processing module), and all persisted preferences/session files (via Node's `fs/promises`, scoped to `app.getPath('userData')`). It exposes a narrow, explicit surface to the renderer via `contextBridge` — `window.api.invoke(channel, payload)` and `window.api.on(channel, listener)` — both of which are channel-agnostic at runtime; **type safety comes entirely from the TypeScript overload declarations in `src/types/electron.d.ts`**, not from any runtime validation. `electron.vite.config.ts` uses `externalizeDepsPlugin()` for both the main and preload builds, which is why native modules like `sharp` work without a manual `electron-rebuild` step (sharp ≥0.32 uses N-API bindings, which are ABI-stable across Node/Electron).

### React
The renderer is a single-page app with **hand-rolled navigation** — there is no router library anywhere in this codebase. `App.tsx` owns one piece of top-level state, `activeModule`, and conditionally renders one of `ModuleSelector` / `Preprocessing` / (`BatchSetup` or `AnnotationWorkspace`, Watch Processing's own internal state). Each screen that needs sub-navigation (e.g., `AnnotationWorkspace`'s Annotation ⇄ Dashboard toggle) manages that with its own local `useState`, not a shared router.

### TypeScript
Used everywhere except the Python pipeline. The mechanical correctness gate for the whole TS codebase is `npx tsc --noEmit` (run from `apps/desktop` for the app, from the repo root for `packages/processing`) — there is no separate lint step enforced in this project's workflow; type-checking has been the consistent bar for "done."

### Python preprocessing pipeline
Lives entirely under `preprocessing/UBG/`, is **spawned as a subprocess**, never imported as a library. Communication is a custom NDJSON-over-stdout protocol (one JSON object per line: `progress`, `heartbeat`, `complete`, `error`, `initializing`, `start`, `done`, `cancel_requested`) plus a stdin control channel used only for cooperative cancellation (`{"cmd":"cancel"}`). This process boundary is deliberate and load-bearing: it's what lets the Python pipeline evolve independently (different dependency versions, different Python interpreter, different hardware acceleration story) without ever coupling to the Node/Electron build.

### Processing engine
`packages/processing` (npm workspace `@wpa/processing`) is the Phase 0 core: pure, sharp-based TypeScript functions with **no Electron or React dependency at all**, directly unit-tested with vitest (`/tests` at the repo root). This is the code PROJECT_SPEC.md calls out as needing to "remain reusable in both local and server-side environments," and it is the one part of this codebase treated as frozen production logic — see Design Principles below.

### IPC architecture
One registration file per concern under `apps/desktop/electron/ipc/`: `batchHandlers.ts` (folder/file dialogs, batch path validation), `dataHandlers.ts` (spreadsheet parse + SKU match), `sessionHandlers.ts` (session save/load + versioned migration), `prefsHandlers.ts` (six independent small preference stores), `processHandlers.ts` (single-watch processing), `queueHandlers.ts` (background processing queue), `preprocessHandlers.ts` (Python subprocess lifecycle + the Workflow Preparation channel). Handlers are deliberately **thin** — validation and error classification happen inline, but actual logic is delegated to `packages/processing`, `electron/services/*.ts`, or the spawned Python process.

### Shared types
`apps/desktop/src/types/ipc.ts` is the single source of truth for every IPC payload/result shape, imported by both the main process and the renderer — this is what makes the channel-agnostic `window.api` bridge type-safe in practice. It is intentionally separate from `packages/processing/src/types/{processing,data}.ts`, which describe the processing engine's *internal* domain math (`SpliceResult`, `ScaleResult`, `AssemblyLayout`) — IPC types describe wire payloads; processing types describe engine internals. Don't conflate the two when adding new fields.

### Plugin architecture
Two genuinely separate "plugin" concepts exist in this codebase, and it's worth being explicit about the distinction so they don't get conflated:
1. **Python object-type plugins** (`preprocessing/UBG/plugins/{watch,bracelet,ring,generic}.py`) — real, implemented, dynamically loaded by `services/plugin_loader.py` based on the `object_type` string passed from the renderer. Each exposes `process(image, masks)` and its own `CONFIG` dict, and owns all category-specific post-segmentation logic (e.g., `watch.py`'s mask-based strap-part removal). `electron_runner.py`, `sam_segmenter.py`, and `background_remover.py` are all category-agnostic — they never know or care what `object_type` was requested. Phase 10 extends this same category-agnostic direction: configurable preprocessing execution modes plus a real AI masking integration for Ring and Bracelet asset generation, followed by Phase 13's Earring generator built on the same foundation.
2. **The Boundary Provider pattern** (`PROJECT_SPEC.md`) — an architectural contract, not yet multi-implemented. Only one provider exists today (manual annotation, `boundarySource: 'manual'`). Phase 12 is the roadmap for adding AI-based providers against this same contract.

---

## Application Structure

| Screen/Component | File | Role |
|---|---|---|
| App shell | `src/App.tsx` | Owns `activeModule` state, dark top nav ("← Modules" + current module name), wraps everything in `PreprocessingJobProvider` so an in-flight job survives module switches, owns the Watch-Processing hand-off state (`handoffFolder`, cleared automatically on leaving the `watch` module) |
| Module Selector | `src/screens/ModuleSelector.tsx` | Landing screen; a `MODULES` array of `{id, title, description}` rendered as cards — adding a future module is one array entry + one `App.tsx` render branch |
| Preprocessing | `src/screens/Preprocessing.tsx` | Folder pickers, Upscale Factor (`SnapSlider`), Product Type dropdown, Python interpreter status/override, Settings gear (opens `PreprocessingSettings` modal), Start/Cancel, delegates live state to `PreprocessingJobContext` |
| Batch Setup | `src/screens/BatchSetup.tsx` | "New Batch" — 3 `PathField`s, Validate, match results, resume-session prompt, Begin Annotation. Also the destination screen for the Preprocessing hand-off (shows the "Prepared ✓" badge + helper text) |
| Annotation Workspace | `src/screens/AnnotationWorkspace.tsx` | Wraps `AnnotationProvider` + `QueueProvider`; renders `AnnotationCanvas` + `InfoPanel` + `ProcessingQueue`, or `BatchDashboard` when the user clicks "Overview" |
| Batch Dashboard | `src/screens/BatchDashboard.tsx` | Filterable (by annotation/processing status)/sortable/searchable table of every SKU; row click jumps back into the annotation flow at that SKU |
| Annotation Canvas | `src/components/AnnotationCanvas.tsx` | Konva-based canvas rendering the watch image plus draggable splice guides (always) and scale guides (only for `measureBy === 'dial'` SKUs) with keyboard nudging and Uniform/Free coupling |
| Info Panel | `src/components/InfoPanel.tsx` | SKU/measurement display, annotation+processing status badges, progress bar, guide-mode toggle, keyboard hints, prev/next/submit |
| Processing Queue | `src/components/ProcessingQueue.tsx` | Live sidebar of queued/processing/complete/failed items with per-item retry |
| Preprocessing Settings | `src/components/PreprocessingSettings.tsx` | Native `<dialog>`-based modal hosting `SamTuningPanel`; the intended home for future preprocessing-only advanced settings |
| SnapSlider | `src/components/SnapSlider.tsx` | Generic, hand-built stepped slider (no library) for discrete preset values — used today for Upscale Factor, designed to generalize to future settings like Detection Density or Candidate Masks |

**Navigation ownership:** `App.tsx` is the *only* place that knows both Preprocessing and Watch Processing exist simultaneously. Preprocessing never imports anything about spreadsheets or Watch Processing folders; the hand-off flows one direction only, orchestrated entirely by `App.tsx`.

---

## Processing Pipelines

### Watch Processing pipeline (`packages/processing`, step by step)

1. `sharp(inputPath).metadata()` — validate the input is a readable PNG with real dimensions.
2. **`spliceImage`** — pure arithmetic: given `leftBoundary`/`rightBoundary` pixel coordinates, compute three `SegmentBox`es (left strap / dial / right strap) from the source image dimensions. No image I/O in this step.
3. **`scaleToMeasurement`** — compute a single scale factor so the dial's pixel width matches its physical measurement (`targetDialWidth = widthMm × PX_PER_MM`, where `PX_PER_MM = 2000/55`). If the SKU's `measure by` is "Dial," an independent pair of **scale boundaries** (drawn by the user as a second, inset set of guides) is used instead of the splice width — letting the dial be measured more precisely than the visual case-crop.
4. **`createCompressedLayout`** — pure arithmetic: fit the scaled dial plus compressed left/right straps into the fixed 2000×2000 canvas, dial horizontally centered, straps compressed to consume exactly the remaining width on each side.
5. **`exportAssembly`** — the actual rendering: `sharp().extract().resize()` each of the three segments per the layout, composite them onto a transparent 2000×2000 canvas, generate a drop shadow (`createDropShadow`: alpha-channel threshold → density-dilate → spread-dilate → Gaussian blur → offset → horizontal gradient mask → recolor), composite the shadow beneath the assembly, trim transparent top/bottom margins, and write the final PNG.
6. Output filename: `SKU;frontImage.png`, written directly into the user's chosen output folder.

### Preprocessing pipeline (`preprocessing/UBG/electron_runner.py`, step by step, per image)

1. Cooperative-cancellation checkpoint (checked only between stages, never mid-inference).
2. **Upscale** — Real-ESRGAN at 2×/4× (MPS-accelerated; cached module-level so the model loads once per batch, not per image) or a no-op copy at 1×.
3. Checkpoint → **BiRefNet background removal** — loaded once, eagerly, before the batch starts; produces an RGBA image whose alpha channel *is* the foreground mask.
4. Checkpoint → **SAM2 automatic mask generation** — lazy-loaded on the first image; grid-based prompt sampling (`points_per_side`), batched decoder calls (`points_per_batch`), filtered by `pred_iou_thresh`/`stability_score_thresh`, capped at `max_masks`. All parameters are renderer-tunable overrides layered on top of unchanged `config.py` defaults.
5. Checkpoint → **Object-type plugin** — dynamically loaded by `object_type`; masks are held in memory only for the duration of this call and never written to disk.
6. Checkpoint → **Save** — the final processed image only (mask/preview debug artifacts were deliberately removed in an earlier optimization pass — see Performance Notes).
7. Throughout: NDJSON `progress`/`heartbeat`/`complete`/`error` events stream to Electron over stdout; a batch-level `done` event reports succeeded/failed/cancelled counts.

### Workflow Preparation pipeline (`apps/desktop/electron/services/workflowPreparation.ts`, step by step)

Triggered *only* by the "Continue to Watch Processing" click — never during a normal preprocessing run, and structurally incapable of touching the Python process or its state.

1. Validate the Preprocessing output folder exists and is a directory.
2. Enumerate supported image files inside it (skipping the `temp/` subfolder and non-images).
3. Clear and recreate a `<output folder> - WatchReady` **sibling** folder (never nested inside the original — this makes re-running Preprocessing into the same output folder and clicking Continue again always regenerate cleanly, with no stale leftovers).
4. For each image, with bounded concurrency (3 at a time, to cap peak memory on large upscaled images): compute the **exact** alpha-channel bounding box via a raw-pixel scan (deliberately *not* `sharp`'s built-in `.trim()`, which is a fuzzy corner-color-similarity heuristic — see Performance Notes for why precision matters here), `sharp().extract(bbox).rotate(-90)`, write to the prepared folder, and report progress via a `preprocess:prepare-progress` IPC event.
5. Per-image fault tolerance: a corrupt or fully-transparent image is skipped, not fatal to the batch.
6. Returns `{ok:true, preparedDir, imageCount, skippedCount}` or `{ok:false, error}` if zero images could be prepared — the caller only navigates to Watch Processing on `ok:true`.

---

## Data Flow

- **Folders** — Watch Processing persists its three folders (input/spreadsheet/output) in `last-batch.json`; Preprocessing persists its two folders (input/output) in `preprocessing-folders.json`. Both validate that saved paths still exist before restoring them on app launch, falling back to empty fields otherwise.
- **Images** — Watch Processing requires PNGs named exactly `SKU.png`; Preprocessing accepts `.jpg/.jpeg/.png/.webp` with arbitrary names, and produces one output image per input image with the same base name.
- **Spreadsheet** — parsed once per Watch Processing batch (`XLSX`/`CSV`, required columns `sku`/`width`/`height`/`measure by`), matched against discovered images by case-insensitive SKU, feeding both the match summary and each SKU's per-annotation measurement display.
- **Annotations** — held in `AnnotationContext` as `WatchAnnotation[]` (`sku`, `status`, `spliceBoundaries`, `scaleBoundaries`), each boundary tagged with `source: 'manual' | 'ai'` and `confidence: number | null` even though only `manual` exists today — the shape already anticipates Phase 12.
- **Processing** — `QueueContext` uses an **optimistic-then-reconciled** pattern: a pending item is added to renderer state immediately on Submit (before the main process acknowledges), then removed once the same SKU appears in the main-process-confirmed queue snapshot. The main process itself processes one item at a time via a self-recursing `processNext()` that calls the exact same `processWatch()` the CLI script uses.
- **Exports** — Watch Processing writes `SKU;frontImage.png` directly to the chosen output folder; Preprocessing writes `<name>.<ext>` per source image to its own chosen output folder.
- **Batch state** — `SessionFile` (versioned, currently `SESSION_VERSION = 4`, with an explicit migration chain from v1/v2/v3), stored as `wpa-session-<hash-of-inputFolder+spreadsheetPath>.json` under `userData/sessions/`, autosaved 400ms after any annotation/queue/mode change (debounced), and defensively re-verified on load (any queue item marked `complete` whose exported file no longer exists on disk is reset to `queued`).
- **Preferences** — six independent small JSON files in `userData`, one per concern (`last-batch.json`, `sam-tuning.json`, `upscale-factor.json`, `product-type.json`, `preprocessing-folders.json`, plus session files under `sessions/`), each with its own dedicated `load`/`save` IPC pair. There is **no unified settings store** — this is deliberate, not an oversight; new preferences should follow the same one-file-per-concern shape rather than being merged into an existing file.

---

## Folder Structure

```
/apps/desktop            Electron + React application (the only consumer-facing app)
  /electron               Main process ONLY — Node/fs/native-module code lives here
    main.ts, preload.ts, logger.ts
    /ipc                  One registration file per concern (thin handlers)
    /services             pythonResolver.ts, workflowPreparation.ts
  /src                    Renderer ONLY — no Node APIs, browser-safe code only
    /screens, /components, /context, /hooks, /types

/packages/processing      @wpa/processing workspace package — the frozen Phase 0 engine
  /src/processing          spliceEngine, scalingEngine, compressionEngine, shadowEngine,
                           exportEngine, processWatch (orchestrator), constants
  /src/data                spreadsheetParser, imageDiscovery, skuMatcher
  /src/types               processing.ts, data.ts — engine-internal domain types

/preprocessing/UBG        Standalone Python project — own deps, own config, own models
  electron_runner.py       Subprocess entry point (NDJSON protocol, cancellation, profiling)
  config.py                All tunable defaults in one place
  /services                sam_segmenter.py, upscaler.py, plugin_loader.py
  /stage0                  background_remover.py (BiRefNet)
  /plugins                 watch.py, bracelet.py, ring.py, generic.py
  /models                  Downloaded model weights (BiRefNet, SAM2, Real-ESRGAN)
  /profiling               Generated diagnostic reports (git-ignored working output)
  /docs                    Word-format Beginner/Project/User manuals — external-facing
                           documentation already exists here; extend it, don't duplicate it

/tests                    Root-level vitest suite — currently covers ONLY packages/processing
                           and the data layer (Phase 0). No Electron/IPC or Python pipeline
                           tests exist yet.

/sampledata               Fixture/sample images for manual testing — not runtime code

PROJECT_SPEC.md, IMPLEMENTATION_PLAN.md, CLAUDE.md, PROJECT_BRIEF.md (this file)
                           The four governing documents at repo root
```

**What must never be mixed:**
- Python (`preprocessing/UBG`) is only ever *spawned*, never *imported*, from the Node/Electron side — and the reverse is equally true.
- `packages/processing` must never gain a UI or IPC dependency — it is validated by its independence from `apps/desktop`.
- `apps/desktop/electron/*` (Node/native-module code) must never be imported into `apps/desktop/src/*` (renderer/browser code) — enforced today by convention and the electron-vite process split, not by a lint rule, so be deliberate about which side of that boundary new code belongs on.

---

## Important Design Principles

These are conventions this project has *consistently* followed — not aspirational, observed in every phase of development to date.

- **Single responsibility per IPC handler file.** `batchHandlers.ts` only ever does dialogs + path validation; `dataHandlers.ts` only ever does spreadsheet parse + match. Never let one file grow to cover unrelated concerns.
- **Thin IPC, fat services.** Handlers validate inputs and classify errors; actual logic lives in `packages/processing` or `electron/services/*.ts`.
- **Preprocessing must remain fully independent of Watch Processing.** Verified repeatedly across this project's history: Preprocessing never imports spreadsheet types, never knows Watch Processing folders exist, and the one hand-off point (the Continue action) flows through `App.tsx` only — never a direct cross-module reference.
- **The Watch Processing engine (`packages/processing`) is production logic.** Never modify it without an explicit request. Every optimization/investigation effort in this project's history has been deliberately routed to either the Preprocessing Python pipeline or the Electron layer instead of touching this package.
- **Plugins own all category-specific behavior.** `electron_runner.py`, `sam_segmenter.py`, and `background_remover.py` stay category-agnostic; everything specific to "this is a watch" vs "this is a bracelet" lives in `plugins/*.py`.
- **One phase at a time; never implement future phases unless explicitly requested.** A binding `CLAUDE.md` rule, followed literally — features like SAM tuning UI or Product Type selection didn't appear until they were explicitly asked for, even though the underlying IPC payload fields existed earlier.
- **Explicit before/after ritual for every implementation.** Before: explain architecture, list files, identify risks, wait for approval. After: explain what was built, how to test it, and any assumptions made, then stop and wait for further instructions.
- **Preserve backward compatibility whenever practical.** `SessionFile` carries an explicit `version` field and a real migration chain (v1/v2 → v4, v3 → v4) rather than breaking old session files on a schema change.
- **Reuse existing persistence patterns rather than inventing new ones.** Before adding folder-transfer preferences during the Watch Processing hand-off work, the existing prefs layer was explicitly audited for a reusable merge helper before deciding none existed and following the established load/save-pair pattern instead.
- **Verify before trusting memory or assumption.** Established practice: re-read files before editing them, empirically verify SAM2/PyTorch behavior before changing cancellation logic, confirm `sharp`'s native binding actually loads before building UI around it.
- **Cooperative cancellation only — never signal-based termination for GPU work.** This is a hard-won lesson from a real kernel-panic incident on Apple Silicon MPS; SIGTERM/SIGKILL are never used to cancel a running Python pipeline. Cancellation is checked only at safe checkpoints between pipeline stages.
- **New tunable parameters are renderer-controlled overrides on unchanged defaults, never new hardcoded defaults.** SAM parameters, Upscale Factor, and Product Type all layer optional overrides on top of `config.py`'s existing values — they never silently change what happens when a control is left untouched.
- **Async operations that gate navigation must fail closed.** The Watch Processing hand-off only navigates on an explicit `ok:true`; any failure keeps the user on the current screen with a visible, actionable error.
- **No speculative configurability.** IPC payload fields like `background`, `edgeMode`, and `outputSuffix` already exist in the contract but have no UI control — they were added for future phases and are deliberately left unexposed until a phase actually calls for them.

---

## Current Features

### Watch Processing
- Batch setup with input/spreadsheet/output folder validation
- SKU matching with duplicate detection on both spreadsheet and image sides
- Session resume (continue a previous batch exactly where it left off)
- Dual-boundary annotation: splice guides (always) + independent scale guides for "Dial" measure-by SKUs
- Uniform (mirrored) and Free (independent) guide modes, with keyboard nudging (±1px, ±10px with Shift)
- Background processing queue with optimistic UI updates and per-item retry on failure
- Session autosave with versioned schema migration (v1→v4, v2→v4, v3→v4) and self-healing output-file verification on load
- Batch Dashboard: filter by annotation/processing status, sort by SKU/annotation/processing, search by SKU, click-to-jump
- Full processing pipeline: splice → scale-to-measurement → compress → assemble → drop shadow → transparent-margin trim → export

### Preprocessing
- Python interpreter auto-discovery with manual override
- Persisted input/output folder selection (survives app restarts)
- Upscale Factor via a custom stepped slider (1×/2×/4×, Real-ESRGAN, MPS-accelerated)
- Product Type selector (Watch/Bracelet/Ring/Generic) driving the Python-side object plugin
- SAM tuning settings modal (points_per_side, points_per_batch, pred_iou_thresh, stability_score_thresh, max_masks, multimask_output) — renderer overrides on top of unchanged Python defaults
- Live per-image, per-stage progress with a heartbeat signal so long-running stages never look frozen
- Cooperative cancellation (safe at any point, never interrupts GPU work mid-kernel)
- Completion summary (succeeded/failed/cancelled counts, total runtime)
- Extensive Python-side profiling instrumentation (per-stage timing, RSS/MPS memory, SAM2-internal candidate-mask flow) written to a persistent report file

### Workflow Integration
- Module Selector as the app's landing screen, with a dark shell navigation bar ("← Modules" + current module name) distinct from each module's own light content
- One-click "Continue to Watch Processing" from a completed Preprocessing run
- Automated trim-to-content + 90° rotation preparation step with live progress, writing to a clearly-named sibling folder that never touches the original Preprocessing output
- Contextual "Prepared ✓" badge and helper messaging in Batch Setup when the input folder came from a prepared Preprocessing run — no interrupting dialogs

---

## Current UI

The application currently uses a **light, clean, card-based design system** across the content screens (Batch Setup, Preprocessing, Annotation Workspace) — primary text/buttons in `#1a1a1a`, with green/amber/red accents for ok/warn/error states, consistent spacing and typography reused across every screen rather than each screen inventing its own look.

The **shell chrome** (`App.tsx`'s top navigation bar) is deliberately dark, giving a clear "app frame vs. content" visual hierarchy — the user always knows they're inside a persistent application shell, distinct from whatever content screen is currently active.

Notable UX decisions already implemented:
- The Settings modal uses the browser's **native `<dialog>` element** rather than a custom modal library or hand-rolled overlay — simpler, and gets focus-trapping and Escape-to-close for free.
- **SnapSlider** is a fully custom, library-free stepped slider, deliberately designed generically (not "UpscaleFactorSlider") so future discrete-preset settings can reuse it without modification.
- **Disabled-state dimming** is applied consistently across every config control while a job is running, so users can never edit configuration mid-run — this pattern is used identically in both Preprocessing and (implicitly, via existing form-disable conventions) elsewhere.
- **Badges and inline helper text, not interrupting dialogs**, are the established pattern for contextual hints (e.g., "Prepared ✓") — an explicit UX principle adopted during the Workflow Integration phase specifically to avoid breaking flow with a confirmation dialog where a passive visual cue suffices.
- Progress feedback for potentially-long operations (Preprocessing runs, Workflow Preparation) always includes a live counter or heartbeat, never a bare spinner with no numeric feedback.

---

## Current State of Development

As of the most recently completed phase (Phase 8.5D, per git history), the application provides:

- A **fully production-capable manual Watch Processing workflow** (Phases 0–8): batch setup through export, with session persistence, background queueing, and a full batch-management dashboard. This is the original, longest-running, most heavily tested part of the application.
- A **working, tunable, MPS-accelerated Preprocessing module** (Phase 8.5A–C): capable of running a real Python computer-vision pipeline (BiRefNet background removal + SAM2 segmentation + optional Real-ESRGAN upscaling) as a first-class Electron-integrated feature, with live progress, cooperative cancellation, and renderer-exposed tuning for both the upscaler and the segmentation model.
- A **connective Workflow Integration layer** (Phase 8.5D): the two modules, while architecturally independent, can now be used together as a single practical workflow — raw photography in, through Preprocessing, automatically prepared, and handed into Watch Processing — without the user re-doing folder selection or losing any context.
- Significant **performance engineering work** on the Preprocessing pipeline (documented in detail below), converting an initially CPU-bound, MPS-underutilized pipeline into one that correctly uses Apple Silicon GPU acceleration across all three models, with several genuinely subtle bugs found and fixed via targeted instrumentation rather than guesswork.

This is not a list of commits — it is a description of what a user can actually do with the application today: process an entire folder of raw watch photography through automated background removal and segmentation, seamlessly hand that output into the existing manual annotation/scaling/export workflow, and get production-ready VTO assets out the other end, with no manual Photoshop work required at any stage.

---

## Performance Notes

This section exists to preserve engineering knowledge from an extensive profiling and optimization effort on the Preprocessing pipeline — read this before touching `preprocessing/UBG/services/{sam_segmenter,upscaler}.py` or `stage0/background_remover.py`.

### MPS acceleration
- BiRefNet and SAM2 both correctly used MPS from the start, via a consistent `_best_device()` priority order (CUDA → MPS → CPU).
- **Real-ESRGAN did not.** Its device-selection logic only checked `torch.cuda.is_available()`, silently falling back to CPU on Apple Silicon — a real, shipped bug, not a theoretical one. It was found via targeted diagnostic instrumentation (not guesswork) that logged `device_selected`, `unexpected_cpu`, and per-substage timings. The fix was a 4-line device-priority change (CUDA → MPS → CPU, matching the pattern already used elsewhere). Measured impact: 2× upscale time dropped from **~52s to ~14s per image**.
- `half` (fp16) precision remains intentionally tied to `device.type == "cuda"` only — MPS runs float32 by design, which is the safe, zero-risk default; nothing currently depends on fp16 working correctly on MPS.

### Real-ESRGAN
- The upscaler model was originally rebuilt from disk on every single image. A module-level cache (keyed on `scale_factor, tile, device`) now builds it once per batch.
- Model weight resolution was extended to also check a shared top-level `models/` directory, not just the one local to `preprocessing/UBG/`.

### SAM2 findings
- `points_per_batch` was set to `16` — a leftover default tuned for 4GB-VRAM CUDA cards. SAM2's own default is `64`. Raising it recovered a large multiple of throughput for **zero quality cost** (it only changes how many prompts are batched per forward pass, not what the model computes).
- The real 4×-upscale SAM slowdown was **not** inside `generator.generate()` itself. Fine-grained sub-stage instrumentation (timing `prepare`/`generate`/`mask_resize`/`postprocess` separately, plus patching `SAM2AutomaticMaskGenerator`'s internals to count candidate masks at each filtering stage) proved the bottleneck was redundant full-resolution alpha-compositing and RGB conversion happening *before* the image was even resized down to SAM's input size.

### Why a specific optimization was reverted
An attempt to fix the above by reordering "resize, then composite" (instead of "composite, then resize") looked like a pure, safe CPU-savings win — and measurably was, in isolation. But it silently changed the actual pixel content fed into SAM2: alpha compositing on a **straight-alpha** image is not commutative with resizing, and reordering it introduced RGB contamination at transparent boundaries (residual background color bleeding into what should be clean edges), creating a visible "halo" that SAM2 misread as extra structure — roughly **doubling** the candidate-mask count and, consequently, non-maximum-suppression cost. This was caught by A/B testing actual output quality, not just wall-clock time, confirmed as a genuine regression, and fully reverted. A permanent code comment now guards the reverted code path against reintroduction.

### Architectural lessons learned
- **Never trust a "should be faster" reorder near a model's actual input without checking pixel content, not just wall-clock time.** A change can be objectively cheaper in CPU terms and still be wrong if it changes what the model actually sees.
- **Instrument before optimizing, always** — including changes that look obviously safe. Every real fix in this section came from targeted profiling data, not intuition.
- **GPU work must only ever be interrupted at safe checkpoints between operations, never via process signals.** This was learned from a real macOS kernel panic triggered by SIGTERM arriving mid-MPS-kernel-execution during a naive cancellation implementation — the fix (cooperative, checkpoint-based cancellation) is now a hard architectural rule, not a preference.

---

## Roadmap

`IMPLEMENTATION_PLAN.md` is the authoritative roadmap and defines phases through **Phase 13**. The summaries below mirror it — if the two ever diverge, the plan document wins and this section should be corrected to match.

Since Phase 10, the roadmap alternates between phases that expand product capability (a new supported product type, or new user-facing functionality) and phases that strengthen the platform's architecture, reliability, and performance in response to that growth. Architecture Strengthening is not a one-time phase — it is a recurring activity, revisited after each major expansion and numbered sequentially ("Run 1," "Run 2," …) rather than treated as a single finished milestone.

**Phase 9 — Workflow & Experience Refinement.** Transform WatchAutomation from a collection of functional modules into a single cohesive production application. Broader than visual polish: workflow design (separating configuration from execution), persistent batch management and a dedicated batch browser across both modules, navigation, a richer progress-visualization dashboard (live thumbnail grid, ETA, per-image status), a processed-image inspector (before/after, zoom/pan), a unified design language, and a centralized global-settings experience. Purpose: make the application feel like one product rather than several modules bolted together.

**Phase 10 — Ring & Bracelet Asset Generation.** Extends WatchAutomation beyond Watches into a second and third supported product type, delivered as five milestones: (10A) make Preprocessing product-agnostic, with configurable execution modes (Upscale only / Background Removal only / Both) so it can serve as the upstream pipeline for any product, not just Watches; (10B) study the existing AI masking module, identify its inputs/outputs and reusable components, and design its integration — no production integration yet; (10C) integrate that model to generate `frontFullImage`/`frontImage` outputs, keeping preprocessing and asset generation cleanly separated; (10D) enable Ring and Bracelet editing entries with a workflow/progress/review/batch experience consistent with Watches; (10E) QA, performance validation, regression testing, and large-batch verification. Purpose: prove out the product-agnostic-preprocessing-plus-per-product-asset-generator architecture with two real product types at once.

**Phase 11 — Architecture Strengthening — Run 1.** The first recurring architecture pass, undertaken now that Watch and Ring/Bracelet workflows exist side by side. Optimize memory/CPU/GPU/throughput, pipeline parallelism and caching, reduced disk I/O, crash/interruption recovery, expanded structured logging and diagnostics, and architecture/plugin-interface cleanup (including removing temporary implementations introduced in earlier phases) — all without changing user-facing workflows. Purpose: a stable, performant foundation for Phase 12's AI work, and for every future asset generator.

**Phase 12 — AI-Assisted Watch Annotation & Boundary Detection.** Merges what were previously two separate phases into one: first, the `{leftBoundary, rightBoundary, boundarySource}` Boundary Provider abstraction as a real, standardized interface (it already exists informally in `BoundaryData`'s shape) with a Manual/AI provider split and confidence metadata — no AI prediction yet; then the first real AI integration, where a model predicts boundaries that pre-populate the existing manual guides for the user to review and explicitly submit, with prediction confidence displayed. Purpose: decouple "how a boundary was produced" from "the processing engine that consumes it," then spend that decoupling on a trust-building AI increment for Watch annotation specifically — the human remains the source of truth throughout; AI only removes the "drag from scratch" step, not the review step.

**Phase 13 — Earring Asset Generation.** A second, simpler product-specific asset generator, built on the same product-agnostic preprocessing foundation established in Phase 10 — no AI masking model required. Pipeline: Upscale → Background Removal → Trim → resize to 2000px height while preserving aspect ratio → export as `SKU;frontImage.png`. Purpose: prove the preprocessing-plus-asset-generator pattern generalizes cheaply to a product that doesn't need AI-assisted masking, unlike Ring and Bracelet.

**Beyond Phase 13:** `IMPLEMENTATION_PLAN.md` does not currently define further phases. Confidence-gated, fully automated Watch annotation — previously envisioned as an eventual "Phase 13" — is no longer a scheduled phase now that Phase 13 covers Earring Asset Generation instead; it remains a plausible future step, not a committed one. Two further candidates are visible from the existing spec and codebase but are **not committed roadmap items** — flagged here as open questions, not scheduled work:
- **Sandbox/server migration** — `PROJECT_SPEC.md` explicitly names this as the eventual destination for the processing engine ("Future Sandbox Integration... WPA should follow the same architecture to simplify future integration"). No concrete migration plan exists yet.
- **Plugin vocabulary harmonization** — now more concretely relevant with Ring, Bracelet, and Earring joining Watch as real product types: the Preprocessing module's `object_type` (`watch`/`bracelet`/`ring`/`generic`, with an `earring` value likely following in Phase 13) and each product's own asset-generation workflow are currently separate concerns that happen to share naming. Reconciling these two vocabularies (or deliberately keeping them distinct) would need an explicit decision as more product types are added.

---

## Future Extension Points

- **New Preprocessing plugins:** drop a new `preprocessing/UBG/plugins/<name>.py` implementing `process(image, masks)` + a `CONFIG` dict, then add the corresponding value to the renderer's `ProductType` union and `PRODUCT_TYPE_OPTIONS` array. No changes to `electron_runner.py`, `sam_segmenter.py`, or `background_remover.py` are needed — this is the whole point of keeping those files category-agnostic.
- **New top-level app modules:** `ModuleSelector`'s `MODULES` array and the `LaunchableModule` union type are the only two places a new module needs registering; `App.tsx`'s render ternary needs exactly one new branch.
- **Additional AI Boundary Providers:** `PROJECT_SPEC.md`'s Boundary Provider pattern is explicitly designed so a new provider only ever needs to produce `{leftBoundary, rightBoundary, boundarySource, confidence?}` — Phase 12 is the concrete roadmap for building against this contract without ever touching the processing engine.
- **New workflow integrations:** the Preprocessing → Watch Processing hand-off pattern (an async preparation step that gates navigation on success, paired with a contextual badge/message in the destination screen) is a reusable template — any future module-to-module hand-off should follow this same shape rather than inventing a new one.
- **SnapSlider reuse:** deliberately built generic (not "UpscaleFactorSlider") specifically so future discrete-preset settings — Detection Density, GPU Workload, Candidate Masks were named as likely candidates when it was designed — can reuse it with zero component changes.
- **`workflowPreparation.ts` naming:** deliberately generic (not "preprocessingToWatchPrep.ts") so future module-to-module preparation logic can live alongside `prepareForWatchProcessing()` in the same file without a rename.

---

## Development Guidelines

**Coding style:** TypeScript throughout the app layer; comments only where they explain non-obvious *why* (a hidden constraint, a workaround, a subtle invariant) — never comments that restate what the code visibly does. CSS Modules, one per component; match the existing visual language exactly unless a redesign is explicitly requested.

**Architecture philosophy:** services own logic, IPC handlers stay thin. Renderer hooks own the "load on mount, save on change" persistence pattern for preferences (see every `use*` hook under `src/hooks/`). React Context is reserved for state that must survive a component unmounting/remounting across navigation (`PreprocessingJobContext`, `QueueContext`, `AnnotationContext` are the established precedent) — everything else should be a plain hook, not promoted to Context "just in case."

**Implementation workflow:** every phase follows `CLAUDE.md`'s explicit ritual — before writing code: explain architecture, list files to be created/modified, identify risks, and wait for approval; after implementing: explain what was built, how to test it, and any assumptions made, then stop and wait for further instructions. Never implement a future phase preemptively, and never modify the Phase 0 processing engine without an explicit request.

**Testing expectations:** `vitest` unit tests exist today only for `packages/processing` and its data layer (`/tests` at repo root) — any new processing-engine logic should get a corresponding test there. There is currently **no automated test harness** for the Electron/IPC layer, the React UI, or the Python pipeline; Playwright/E2E automation for this app was explicitly evaluated and rejected in favor of manual verification against the running dev application. This is a known, accepted gap, not an oversight — be aware of it rather than assuming coverage that doesn't exist.

**Review process:** `npx tsc --noEmit` (run from `apps/desktop`, and separately from the repo root for `packages/processing`) is the mechanical correctness gate for every TypeScript change. `python -m py_compile <file>` is the equivalent minimum bar for Python changes. When changing the Preprocessing profiling report format, never remove an existing report section — downstream manual analysis has come to depend on the sections already present.

---

## Notable Implicit Knowledge (things easy to miss on a first read)

- **The dual-boundary system is subtle.** Splice boundaries always exist for every SKU; scale boundaries are a *second, independent* pair of guides that only appear (and only matter) when a SKU's `measure by` column is `"dial"` (case-insensitive). A SKU measured "by case" uses its splice width directly for scaling; a SKU measured "by dial" uses the separate, inset scale guides instead — the dial can be measured more precisely than its visual crop. Missing this distinction is the single easiest way to misunderstand the annotation UI.
- **`QueueContext`'s optimistic-then-reconciled pattern** is a reusable technique worth recognizing elsewhere: add renderer state immediately on user action, before any IPC round-trip completes, then discard it the moment the authoritative main-process state contains the same key (SKU). This avoids UI lag without needing a loading spinner on every submit.
- **`SessionFile` versioning is a real, working migration chain**, not just a version number that happens to sit unused. Any future session-shape change must add a new migration branch in `sessionHandlers.ts`'s `session:load` handler and bump `SESSION_VERSION` — not just change the interface and hope old files still parse.
- **User-facing documentation already exists** at `preprocessing/UBG/docs/` (Beginner Manual, Project Summary, User Manual — Word format). Extend these when Preprocessing-facing behavior changes; don't create a second, competing set of user docs elsewhere.
- **The root-level `tests/` directory covers only Phase 0** (the processing engine and data layer). There is no test coverage for anything added since — the entire Preprocessing module, Workflow Integration, or any Electron IPC handler. This is a real gap in the project's safety net, worth keeping in mind before any refactor of untested code.
- **`sharp` was only recently made an explicit dependency of `apps/desktop`** (during the Workflow Preparation work) — before that, it worked purely by monorepo hoisting from `@wpa/processing`'s own dependency. Anyone assuming native-module hoisting "just works" in this monorepo should know it was previously an implicit, undeclared reliance, not a guaranteed pattern.
- **`electron.vite.config.ts`'s `externalizeDepsPlugin()`** is why adding a new native Node dependency to the main process doesn't currently require a manual rebuild step — it's specifically because `sharp` (and any future similarly-built native module) uses ABI-stable N-API bindings. This is worth re-verifying for any *other* native module before assuming the same free ride applies.
- **Two same-named-sounding "plugin" systems exist and are unrelated:** the Python `object_type` plugins (`plugins/watch.py` etc.) and the Boundary Provider pattern from `PROJECT_SPEC.md`. Don't conflate a request about one with the other.

