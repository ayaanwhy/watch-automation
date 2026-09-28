# Automation Engine

The Automation Engine turns a Temporary Batch + a Universal Configuration into
processed, reviewable results: preprocessing → product editing → post-processing.
It is a **client-agnostic** component. The Electron UI is one client of it; a
future Sandbox API adapter, a CLI or another service can be others.

```
   Electron renderer        future API adapter         CLI / script
          │                        │                        │
   ipc/sandboxHandlers.ts    (not built yet)          (not built yet)
          └───────────────┬────────┴────────────────────────┘
                          ▼
            engine/automationEngine.ts   ← THE interface
                          │
   job lifecycle · persistence · orchestration · progress · errors
                          │
        ProcessingBackend (local today) → Python runners / AI service
```

## The interface (`automationEngine.ts`)

| Call | Meaning |
| --- | --- |
| `createJob(batch, config)` | Validate + preflight + persist a job (`draft`) with its full per-image plan. Nothing runs. No job is created on failure (a structured `AutomationError` is returned). |
| `startJob(jobId)` | Begin executing in the background; returns immediately. |
| `submitJob(batch, config)` | `createJob` + `startJob`. |
| `getJobState(jobId)` | Latest **persisted** state — the source of truth, valid after any client reload/restart. |
| `listJobs()` | Summaries of all jobs. |
| `subscribeToJobProgress(listener, jobId?)` | Live structured updates; each event carries the full job state. Returns unsubscribe. |
| `cancelJob(jobId)` | Cooperative: queued work never starts, in-flight work finishes, completed work is never relabelled. |
| `getJobArtifacts(jobId)` | Per-product final artifact dir + metadata artifacts (CSV/XLSX). Only set once post-processing genuinely completed. |
| `recoverInterruptedJobs()` | Called at engine start: jobs left in flight by a dead process are recorded as `RUN_INTERRUPTED` (never left "running", never silently resumed). |

**Job state** is the persisted `SandboxRun` record (`src/sandbox/types/sandboxRun.ts`),
enriched with: per-image `stages[]` (Upscaling, Background Removal, Trim, Rotate,
Resize, AI Boundary Detection, product editing, one entry per post-processing
script), per-image/per-product/run-level structured `failure`, `startedAt` /
`finishedAt`, and a per-product `activity` string. The renderer is never the
source of truth.

## Progress model

* Real signals only: the runners' own NDJSON `progress`/`complete`/`error`
  events (the same stream Legacy's manual flow consumes), Watch's per-item
  steps, and the orchestrator's own stage boundaries. Heartbeats are ignored.
* Batch-global post-processing scripts have no per-image progress; they are
  reported as `Running <script> — batch post-processing`, never a percentage.
* Updates are buffered (~150 ms) into one persisted write and one event.
* `summarizeImageProgress()` (`src/sandbox/lib/sandboxRunProgress.ts`) is a pure
  function over job state (counts, current image/stage, per-product counts, rate).
  ETA is `null` unless ≥2 images have finished per-image work after ≥3 s, and
  covers image processing only (post-processing time is unknown).

## Error model (`src/sandbox/types/automationError.ts`)

Every failure is an `AutomationError { code, stage, stageDetail?, productType?,
sku?, message, technicalMessage?, retryable, action?, cause? }`, built from a
single catalog so the same failure always reads the same. Free-text from
external services is never parsed (Watch detection failures are classified from
structured fields; runner completion from `failureKind`/counts; Python
dependency errors from the exception class name). Technical detail (stderr
tail, exception text, HTTP status) lives only in `technicalMessage`/`cause`.

## Host seam (`runtime.ts`)

`configureEngineRuntime({ dataDir, projectRoot, tempDir })` tells the engine
where to keep `sandbox-runs/` and where `postProcessing/` (and the other
bundled runners) live. The defaults bind to Electron (`userData`, app path,
temp).

## What is still Electron-bound (honest list)

The engine does **not** depend on React, the renderer, IPC or any window. It
still reuses Legacy processing primitives that read Electron's `app` directly
and must be given the same seam before a standalone (non-Electron) host works:

* `services/batchRegistry.ts` (each product pipeline runs on an ordinary Legacy `Batch`)
* `services/subprocessRunner.ts` + `ipc/{preprocess,ringBracelet,earring}Handlers.ts` (the Python runners; their `mainProcessJobEvents` bus is what the engine observes)
* `logger.ts`, `services/pythonResolver.ts`, `services/boundaryEndpointPrefs.ts`

Handing the engine to another team therefore means: take `electron/sandbox/**`,
`electron/services/**`, `src/sandbox/{types,lib}/**`, `preprocessing/`,
`postProcessing/`, and replace the Electron shims those files use (`app` paths,
`BrowserWindow` broadcast in `notifyAllWindows`) — no UI code is involved.
