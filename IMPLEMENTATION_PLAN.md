Development Rules

* Implement only one phase at a time.
* Do not implement future phases unless explicitly instructed.
* Processing engine is considered production logic and must not be modified unless requested.
* Every phase must be independently testable.
* After each phase:
    * Explain what was built.
    * Explain how to test it.
    * List assumptions made.
    * Stop and wait for approval.

⸻

Phase 0 — Processing Engine Foundation ✅

Goal

Prove the core watch-processing pipeline works before building UI.

Deliverables

* Splice Engine
* Scaling Engine
* Centering Engine
* Strap Compression Engine
* Shadow Engine
* Export Engine

Input

* PNG
* Width Measurement
* Left Boundary
* Right Boundary

Output

* 2000x2000 PNG

Success Criteria

* Dial scaled correctly
* Dial centered at (1000,1000)
* Straps compressed correctly
* Shadow applied correctly
* Export generated correctly

⸻

Phase 1 — Application Shell

Goal

Create the application structure and batch creation flow.

Deliverables

Frontend

* React application setup
* Application layout
* Navigation structure

Backend

* Node application setup
* Shared types
* API structure

Batch Setup Screen

* Input folder picker
* Spreadsheet picker
* Output folder picker

Validation

* Verify paths exist
* Verify spreadsheet exists
* Verify images exist

Success Criteria

User can:

1. Select image folder
2. Select spreadsheet
3. Select output folder
4. Create batch

⸻

Phase 2 — Data Layer & SKU Matching

Goal

Load and validate production data.

Deliverables

Spreadsheet Parsing

* XLSX support
* CSV support
* Column normalization

Image Discovery

* Scan image folder
* Detect PNG files

SKU Matching

Display:

* Matched Items
* Missing Spreadsheet Records
* Missing Images

Batch Model

Create internal batch representation.

Success Criteria

User can load a real batch and see accurate matching results.

⸻

Phase 3 — Annotation System

Goal

Allow users to define dial boundaries.

Deliverables

Annotation Canvas

* Watch preview
* Large square canvas
* Responsive layout

Guide System

* Left boundary guide
* Right boundary guide
* Default 20% / 80%

Modes

* Uniform Mode
* Free Mode

Keyboard Controls

* ±1px movement
* ±10px movement

Navigation

* Previous
* Next
* Jump between watches

Success Criteria

User can annotate an entire batch.

No processing required yet.

⸻

Phase 4 — Annotation Persistence

Goal

Preserve annotation progress.

Deliverables

Batch State Storage

Store:

* Current watch
* Boundary positions
* Annotation status

Recovery

Application restart should restore progress.

Re-Submission Support

Previously annotated watches remain editable.

Success Criteria

User can stop work and continue later.

⸻

Phase 5 — Processing Integration

Goal

Connect annotation data to the processing engine.

Deliverables

Boundary Provider

Convert annotations into processing inputs.

Engine Integration

Connect:

* Boundary data
* Measurement data
* Processing engine

Output Generation

Generate final watch assets.

Success Criteria

Annotated watches produce finished exports.

⸻

Phase 6 — Background Queue

Goal

Allow processing while annotation continues.

Deliverables

Processing Queue

* Job queue
* Status tracking

Progress Tracking

States:

* Pending
* Processing
* Complete
* Failed

Retry Support

Allow failed jobs to be rerun.

Success Criteria

User can annotate while exports are generated.

⸻

Phase 7 — Batch Management

Goal

Provide visibility into large production batches.

Deliverables

Batch Dashboard

Display:

* Total items
* Annotated items
* Processed items
* Failed items

Filtering

* Pending
* Completed
* Failed

Search

* Search by SKU

Success Criteria

User can manage large batches efficiently.

⸻

Phase 8 — Production Hardening

Goal

Prepare the application for daily use.

Deliverables

Error Handling

* Missing files
* Invalid spreadsheets
* Corrupt images

Logging

* Processing logs
* Error logs

Validation

* Input validation
* Measurement validation

Performance Review

* Large batch testing
* Memory testing

Success Criteria

Application remains stable on large real-world batches.

⸻

Phase 8.5 — Preprocessing Module Integration

Goal

Introduce a modular preprocessing stage to WatchAutomation while keeping the existing Watch Processing workflow fully functional and independent.

The preprocessing module is intended to prepare raw product imagery before manual annotation. It operates as a standalone pipeline that can also hand off its output directly into Watch Processing.

⸻

Phase 8.5A — Python Runtime Integration

Objective

Establish communication between the Electron application and the Python preprocessing pipeline.

Scope

* Spawn the Python preprocessing runner (electron_runner.py) from Electron.
* Stream newline-delimited JSON events from stdout.
* Parse progress, completion, error and heartbeat events.
* Handle process lifecycle (launch, cancellation, completion and failures).
* Preserve complete independence from the existing Watch Processing module.

Deliverable:

A reliable Electron ↔ Python bridge capable of running preprocessing jobs.

⸻

Phase 8.5B — Modular Application Navigation

Objective

Convert the application into a multi-module workflow.

Scope

Replace the current startup screen with a module selector.

Watch Automation
• Preprocessing
• Watch Processing

Requirements:

* Existing Watch Processing remains unchanged.
* Both modules are independently launchable.
* Future modules can be added without redesigning navigation.

Deliverable:

Extensible application shell supporting multiple processing modules.

⸻

Phase 8.5C — Preprocessing User Interface

Objective

Provide a dedicated interface for launching preprocessing jobs.

Scope

Inputs:

* Source image folder
* Output folder
* Upscale factor
* Object type
* Processing options (future)

Outputs:

* Live processing progress
* Current image
* Current processing stage
* Completion summary
* Error reporting

The interface should visually align with the existing Watch Processing screens to maintain consistency.

Deliverable:

Complete UI for configuring and monitoring preprocessing batches.

⸻

Phase 8.5D — Workflow Integration

Objective

Connect preprocessing output with downstream Watch Processing.

Scope

Support three workflows:

1. Preprocessing only
2. Watch Processing only
3. Preprocessing → Watch Processing

Following successful preprocessing, the application should offer immediate transition into Watch Processing using the generated output folder without requiring the user to repeat setup.

Deliverable:

Seamless hand-off between application modules.

⸻

Deferred Work

The following functionality is intentionally excluded from Phase 8.5:

* Automatic strap segmentation
* AI splice boundary prediction
* AI scaling boundary prediction
* Automatic annotation generation

These capabilities will be introduced in later phases without requiring architectural changes to the preprocessing framework.

____

Phase 9 — Workflow & Experience Refinement

Goal

Transform WatchAutomation from a collection of functional modules into a cohesive production application. This phase is broader than visual polish — it covers workflow design, persistent batch management, navigation, persistence, progress visualization, processed-image review, settings, and overall application cohesion. The result should be a unified workflow, a polished interface, and persistent batch management across both modules.

Deliverables

Batch Management

Introduce persistent batches across both Preprocessing and Watch Processing.

Each batch should include:

* Automatically generated batch name
* Optional custom batch name
* Creation date
* Module (Preprocessing / Watch Processing)
* Current status
* Image counts
* Processing statistics

Support:

* Running
* Completed
* Failed
* Cancelled

Batch history should persist between application launches.

⸻

Batch Browser

Provide a dedicated batch history view.

Display:

* Batch name
* Date
* Status
* Number of images
* Completion percentage
* Processing duration

Support:

* Search
* Sorting
* Future filtering

⸻

Workflow Refinement

Separate configuration from execution.

For Preprocessing:

Configuration Screen

↓

Dedicated Progress Screen

↓

Completion Summary

↓

Continue to Watch Processing

The running experience should no longer share the same screen as configuration.

⸻

Rich Progress Experience

Replace the current textual progress display with a visual production dashboard.

Display:

* Live thumbnail grid
* Current stage
* Progress overlay on each image
* Current image preview
* ETA
* Overall batch progress

Completed images should update live.

⸻

Image Inspector

Allow inspection of processed results.

Support:

* Before / After comparison
* Interactive comparison slider
* Zoom
* Pan
* Full-resolution preview

⸻

Unified Application Design

Standardize the application visually.

Refine:

* Navigation
* Headers
* Empty states
* Typography
* Spacing
* Icons
* Button hierarchy
* Status colours

The application should feel like a single product rather than multiple modules.

⸻

Global Settings

Introduce a centralized application settings experience.

Examples:

* Appearance
* Performance
* Default folders
* Python configuration
* Advanced preprocessing options

Module-specific settings should move out of individual screens where appropriate.

⸻

Success Criteria

The application presents a cohesive production workflow with persistent batch management, polished navigation, consistent interaction patterns, and significantly improved visual feedback.

⸻

Phase 10 — Ring & Bracelet Asset Generation

Goal

Extend WatchAutomation beyond Watches by introducing Ring and Bracelet asset generation — built on a preprocessing pipeline that becomes product-agnostic, and on a dedicated AI-assisted masking pipeline investigated and integrated specifically for this phase.

This phase is restructured into milestones that build the feature incrementally: a universal preprocessing pipeline first, then AI investigation, integration, workflow UI, and production hardening.

⸻

Phase 10A — Universal Preprocessing Pipeline

Objective

Make preprocessing product-agnostic so it can serve as the upstream pipeline for any future product type, not just Watches.

Scope

* Introduce configurable execution modes:
  * Upscale only
  * Background Removal only
  * Both
* Ensure preprocessing can become the upstream pipeline for any future product type.

Deliverable:

A product-agnostic preprocessing pipeline with selectable execution modes.

⸻

Phase 10B — Ring & Bracelet AI Investigation

Objective

Study the existing AI masking module and design its integration into WPA before any production work begins.

Scope

* Study the existing AI masking module.
* Identify required inputs/outputs.
* Determine reusable components.
* Design integration into WPA.

No production integration yet.

Deliverable:

A validated integration design for the Ring & Bracelet masking model.

⸻

Phase 10C — Ring & Bracelet Asset Generator Integration

Objective

Integrate the masking model to generate Ring and Bracelet assets.

Scope

* Integrate the masking model.
* Generate:
  * frontFullImage
  * frontImage

Keep preprocessing and asset generation cleanly separated.

Deliverable:

A working Ring & Bracelet asset generator producing frontFullImage and frontImage outputs.

⸻

Phase 10D — Ring & Bracelet Workflow UI

Objective

Bring Rings and Bracelets into the application as first-class editing workflows.

Scope

* Enable the Rings and Bracelets editing entries.
* Build the workflow, progress, review and batch experience consistent with Watches.

Deliverable:

Rings and Bracelets are usable end-to-end through the same batch-first workflow experience as Watches.

⸻

Phase 10E — Product-Specific Editing Refinement

Objective

Refine the Ring & Bracelet editing pipeline so each product behaves according to its own editing guidelines while preserving the shared Editing architecture.

Scope

* Separate Ring and Bracelet masking behavior where required.
* Keep Bracelet as the proven baseline implementation.
* Develop Ring-specific masking logic where bracelet assumptions break down.
* Align generated assets with WPA's editing guidelines and orientation conventions.
* Ensure frontFullImage and frontImage generation is correct for both product types.

Deliverable:

Ring and Bracelet asset generation produces correct editing assets for each product while remaining under a shared Editing workflow.

⸻

Phase 10F — Workflow Experience & Review

Objective

Polish the Universal Preprocessing and Editing workflows so operators have a clear, intuitive experience throughout batch creation, processing, handoff, and review. The focus of this phase is usability, workflow efficiency, testing convenience, and review ergonomics—not processing algorithms or architectural cleanup.

Scope

* Improve progress reporting for long-running operations with clearer processing states and confidence indicators.
* Surface masking confidence and review indicators more clearly.
* Replace the Editing product dropdown with segmented/tile selection.
* Improve review interactions through a fullscreen inspection mode with keyboard navigation and image browsing.
* Introduce Testing vs Production batch modes with filtering on Home, independent auto-numbering, and testing-specific conveniences (automatic output folder enumeration and batch re-run).
* Improve batch creation UX by replacing the inline Home expansion with a modal/dialog-based flow.
* Convert Universal Preprocessing into a queue-style workspace where completed/running batches remain accessible while allowing additional batches to be created.
* Introduce a configurable Preprocessing → Editing handoff dialog supporting optional Trim Image and Rotate (Clockwise, Anti-clockwise, 180°) operations before entering the Editing workflow.
* Enable folder creation directly from native folder-picker dialogs where supported.
* Rename application branding from “Watch Automation” to “VTO Automation.”
* Refine the Editing and Preprocessing experiences so they match the overall quality and consistency of the Watch workflow.

Deliverable:

Universal Preprocessing and Editing provide a polished, production-ready workflow with intuitive navigation, efficient testing, informative progress feedback, streamlined handoff between stages, and a consistent review experience across all supported product types.
⸻

Phase 10G — Production Hardening

Objective

Validate and harden the Ring & Bracelet workflow for day-to-day production use.

Scope

* Validate against representative Ring and Bracelet production datasets.
* Verify cancellation, recovery, reopening batches and historical batches.
* Verify output correctness, asset naming and persistence.
* Eliminate remaining workflow rough edges discovered through real-world testing.
* Final production QA before Architecture Strengthening.

Deliverable:

Ring & Bracelet editing is considered production-ready for internal use and ready to enter the first Architecture Strengthening pass.

⸻

Success Criteria

Rings and Bracelets can be processed end-to-end — from raw imagery through AI-assisted masking to finished assets — using the same batch-first workflow as Watches, on a preprocessing pipeline that is now product-agnostic.

⸻

Phase 11 — Architecture Strengthening — Run 1

Goal

Multiple product workflows now exist side by side (Watches, and Rings & Bracelets from Phase 10). Strengthen the platform's architecture, reliability, and performance for large-scale production use across all of them, without changing user-facing workflows.

Guiding Principles

The objective of Phase 11 is to strengthen the application’s architecture while preserving existing functionality, workflows, and user experience. This phase focuses exclusively on maintainability, reliability, observability, and scalability. No new user-facing functionality should be introduced unless explicitly approved.

Engineering Principles

Throughout Phase 11:

* Preserve existing behaviour unless a change has been explicitly approved.
* Prioritize evidence-backed improvements over speculative optimization.
* Remove duplication before introducing new abstractions.
* Introduce abstractions only where justified by existing duplication or architectural evidence.
* Prefer simple, maintainable solutions over generalized frameworks.
* Preserve existing IPC and NDJSON contracts unless a coordinated change is required.
* Complete each sub-phase as an independently releasable checkpoint.
* Validate the application after every completed sub-phase before proceeding.
* If implementation reveals new architectural information that materially affects the remaining roadmap, pause implementation, document the findings, propose revisions, and await approval before continuing.

____

Phase 11A — Stabilization, Cleanup & Foundation

Objective

Resolve confirmed production defects, eliminate obsolete code, and reduce the architectural surface before any structural refactoring begins.

Dependencies

None.

Scope

Immediate Stabilization

Implement the confirmed production fixes identified during the architecture audit.

This includes:

* Introducing safe MPS cache release (torch.mps.empty_cache()) at appropriate synchronization points within the Universal Background Removal pipeline.
* Correcting subprocess exit classification so unexpected exits are always treated as failures.
* Eliminating silent failure paths by logging registry, preference and filesystem errors.

These are considered correctness fixes rather than optimization work.

⸻

Repository Cleanup

Remove confirmed dead or obsolete code, including:

* shankMask project
* obsolete React components
* obsolete IPC channels
* unused exports
* unused helper methods
* obsolete Python entry points
* committed cache files
* committed profiling artifacts
* duplicate model weights
* obsolete generated files
* repository clutter

Review and update repository hygiene where required, including .gitignore.

⸻

Foundation Cleanup

Promote shared utilities and components where architectural ownership is already evident.

Begin evolving toward the long-term processing-stage architecture only where existing code naturally supports it.

Avoid speculative restructuring.

Explicitly Excluded

* Shared runner extraction
* Shared job contexts
* Logging redesign
* Recovery redesign

Acceptance Criteria

* Production defects resolved.
* Repository contains no confirmed dead code.
* Application behaviour remains unchanged.
* All builds and smoke tests pass.

⸻

Phase 11B — Electron Architecture

Objective

Consolidate duplicated orchestration within Electron into shared, reusable infrastructure.

Dependencies

11A

Scope

Implement shared infrastructure for:

* subprocess lifecycle
* process spawning
* cancellation
* NDJSON parsing
* buffering
* state reconciliation
* completion handling
* error handling

Create a reusable subprocess runner configurable per processing pipeline.

Consolidate lifecycle handling into a single implementation, including:

* exit classification
* inactivity detection
* queue management
* subprocess cleanup

The watchdog must never forcibly terminate GPU work. Unresponsive processes should instead be marked failed, released from queue management, and allowed to terminate naturally.

Implement shared filesystem helpers where duplication currently exists.

Capture representative NDJSON protocol outputs before refactoring and verify protocol compatibility afterwards.

Add unit coverage around extracted orchestration logic.

Explicitly Excluded

* Renderer architecture
* Python architecture
* Recovery mechanisms

Acceptance Criteria

* Existing workflows continue functioning identically.
* Duplicate orchestration removed.
* Shared infrastructure adopted across all Electron processing pipelines.
* NDJSON protocol remains backward compatible.

⸻

Phase 11C — Renderer Architecture

Objective

Reduce renderer duplication while preserving existing behaviour.

Dependencies

11B

Scope

Consolidate duplicated renderer infrastructure including:

* JobContext implementations
* Batch synchronization
* Shared processing components
* Shared styling ownership

Extract reusable helpers from large renderer files where clear architectural boundaries already exist.

Promote genuinely shared components into common ownership.

Explicitly Excluded

* Large-scale UI redesign
* State-management rewrites
* User workflow changes

Acceptance Criteria

* Duplicate renderer infrastructure removed.
* Shared ownership boundaries improved.
* Existing UI behaviour unchanged.

⸻

Phase 11D — Python Architecture

Objective

Mirror the shared architectural improvements introduced within Electron.

Dependencies

11B

Scope

Create shared runner infrastructure for Python processing pipelines.

Consolidate:

* argument handling
* validation
* cancellation
* orchestration
* event emission
* exit handling

Preserve independent processing implementations.

Capture golden NDJSON transcripts before refactoring and verify protocol compatibility afterwards.

Introduce load-time plugin validation without expanding the plugin architecture.

Improve project organization only where architectural ownership becomes clearer.

Explicitly Excluded

* Plugin discovery
* Plugin manifests
* New plugin systems

Acceptance Criteria

* Shared runner infrastructure adopted.
* Existing protocol behaviour preserved.
* Processing implementations remain functionally identical.

⸻

Phase 11E — Robustness & Recovery

Objective

Improve resilience once shared infrastructure has been established.

Dependencies

11B, 11D

Scope

Implement:

* startup reconciliation
* registry recovery
* corruption detection
* atomic persistence
* interrupted batch handling

Treat index.json as a rebuildable cache derived from batch detail records.

Quarantine corrupted data where recovery is not possible.

Implement idempotent reruns that naturally skip already completed work.

This is not a resume system.

Explicitly Excluded

* Resume workflows
* Session restoration
* Additional recovery UI

Acceptance Criteria

* Interrupted work is recoverable.
* Registry inconsistencies self-heal where possible.
* Corruption is detected and reported.
* Existing workflows remain unchanged.

⸻

Phase 11F — Logging, Diagnostics & Performance

Objective

Improve observability and implement only evidence-backed performance improvements.

Dependencies

11E

Scope

Implement:

* structured logging
* stack traces
* log rotation
* unified diagnostics
* developer debugging support

Consolidate Python profiling and Electron diagnostics into a consistent reporting model.

Improve temporary-file management.

Perform additional optimization work only where profiling demonstrates measurable benefit.

Explicitly Excluded

* Speculative optimization
* Architectural redesign based solely on theoretical performance

Acceptance Criteria

* Failures are fully observable.
* Diagnostic information is consistent.
* Profiling confirms any optimization work.

⸻

Phase 11G — Validation & Finalization

Objective

Verify the completed architecture and prepare the project for subsequent development.

Dependencies

11A–11F

Scope

Perform:

* full compilation
* automated testing
* functional validation
* large-batch validation
* interruption testing
* corruption testing
* recovery validation

Update all architecture and implementation documentation.

Record remaining technical debt and recommendations for future architectural work.

Acceptance Criteria

* All workflows validated.
* Documentation reflects the implemented architecture.
* Remaining technical debt documented.

⸻

Phase 11 Implementation Rules (Mandatory)

These rules apply throughout Phase 11.

1. Complete one sub-phase at a time.
2. Do not overlap architectural work across phases.
3. Validate every completed sub-phase before continuing.
4. Preserve user-facing behaviour unless explicitly approved otherwise.
5. Remove duplication before introducing abstractions.
6. Base optimization decisions on measured evidence rather than speculation.
7. Preserve IPC and NDJSON compatibility throughout refactoring.
8. Keep every sub-phase independently releasable.
9. At the conclusion of each sub-phase:
    * Verify successful builds.
    * Execute all relevant tests.
    * Perform a functional smoke test.
    * Produce a concise implementation summary.
    * Await approval before proceeding.

⸻

Success Criteria

The application operates reliably on large real-world datasets across multiple product workflows, remains responsive during extended processing sessions, and provides a stable foundation for the AI-assisted annotation work in Phase 12.

⸻

Phase 11 — Completion Summary (Run 1)

All seven sub-phases (11A–11G) delivered and approved. The application behaves identically from the user's perspective — no workflow, IPC channel, or NDJSON event shape changed — while the Electron, renderer, and Python layers each moved from two independently-maintained implementations of the same orchestration pattern (Preprocessing, Ring & Bracelet) to one shared implementation per layer.

What shipped, by sub-phase:
* 11A — Stabilization & cleanup: MPS cache-release fix (targets the Phase 10G escalating-slowdown finding), subprocess exit-classification fix, silent-failure logging across the registry/prefs/filesystem layer, removal of confirmed dead code (shankMask/, three dead components, two dead IPC channels, one dead Python entry point) and committed cache artifacts.
* 11B — Electron architecture: `subprocessRunner.ts` + `subprocessProtocol.ts`, a shared subprocess-job runner (spawn, validation, NDJSON parsing, cancellation, exit classification, image reconciliation) adopted by both Preprocessing and Ring & Bracelet. Added an inactivity watchdog that releases a hung job without ever terminating the underlying process.
* 11C — Renderer architecture: `useSubprocessJob.ts` + `useJobBatchSync.ts` mirror the same shared-engine pattern one layer up; `PreprocessingJobContext`/`RingBraceletJobContext` reduced to thin per-pipeline adapters. Promoted `ThumbnailGrid`/`ThumbnailCell`/`BeforeAfterSlider` and two borrowed stylesheets into `components/shared/`, resolving a cross-pipeline ownership smell identified during the original audit.
* 11D — Python architecture: `preprocessing/runner_base.py` shares argument handling, cancellation, validation, and the NDJSON event/exit-code contract between `electron_runner.py` and `RingBracelet/runner.py`, while deliberately preserving each pipeline's own per-image processing as independent implementations. Added load-time plugin validation (`plugin_loader.py`) — a malformed plugin now fails fast with a clear message instead of a cryptic `AttributeError` at call time.
* 11E — Robustness & recovery: startup reconciliation marks any batch stage stuck at `'running'` (crash/force-quit) as `'failed'`; `index.json` is now treated as a rebuildable cache derived from batch detail files, self-healing on corruption; unreadable detail files are quarantined rather than left to fail forever; prefs/folder-history writes are now atomic (temp-then-rename); Universal Preprocessing skips images whose output already exists, making a rerun of an interrupted batch cheap without a dedicated resume system.
* 11F — Logging & diagnostics: structured NDJSON-formatted log lines (previously plain text), stack-trace capture, a `debug` level, 14-day log/profiling-report retention, corrected stderr-forwarding severity (was uniformly WARN, drowning real warnings in routine diagnostic noise), and basic Electron-side RSS logging alongside Python's existing per-image resource tracking. `electron_runner.py`'s per-batch `temp/` directory is now removed when empty at the end of a run.
* 11G — This validation pass.

Cumulative duplication eliminated (Electron + renderer + Python orchestration layers, 11B–11D): approximately 590–680 lines of logic that previously existed as two independently-maintained near-copies, now existing once per layer. 11A and 11E–11F contributed correctness/resilience/observability improvements rather than deduplication and are not part of that figure.

Benchmark comparison (`npm run benchmark:compare`, baseline captured immediately after 11A vs. final captured at 11G, both against 3-image synthetic fixtures — see the important caveat below):

| Metric | Baseline | Final | Delta |
|---|---|---|---|
| Lines of code (git-tracked) | 16,935 | 16,199 | −4.3% |
| Build time | 1.7s | 1.7s | −3.4% |
| Watch — wall time | 3.4s | 3.3s | −1.1% |
| Universal Preprocessing — wall time | 86.9s | 82.9s | −4.6% |
| Universal Preprocessing — peak RSS | 1,757.6 MB | 1,610.8 MB | −8.4% |
| Universal Preprocessing — peak MPS driver memory | 4,717.0 MB | 4,701.0 MB | −0.3% |
| Ring & Bracelet — wall time | 1.8s | 1.9s | +4.9% |
| Ring & Bracelet — peak RSS | 255.2 MB | 235.6 MB | −7.7% |

No regressions. The Universal Preprocessing RSS/MPS decreases are directionally consistent with the 11A MPS cache-release fix, but with a 3-image synthetic sample this is not strong causal evidence — noted as an observation, not a proven result, per Phase 11's own "base optimization decisions on measured evidence" rule.

**Benchmark methodology caveat:** nothing was committed to git at any point during Phase 11 (per standing instruction — commits happen only when explicitly requested), and the benchmark tool's repo-size/file-count metrics are computed via `git ls-files`. This means the "lines of code" and "tracked files" rows above reflect only 11A's deletions (which register in the git index via `git rm` without a commit) — they do **not** see the 8 new shared-architecture source/test files added in 11B–11G (`atomicFile.ts`, `subprocessProtocol.ts`, `subprocessRunner.ts`, `useSubprocessJob.ts`, `useJobBatchSync.ts`, `runner_base.py`, plus 2 new test files), since none of those were ever `git add`ed. Counted directly from the filesystem, those 8 files total 1,272 lines. The wall-time/RSS/MPS pipeline rows are unaffected by this gap — they execute the actual current files on disk regardless of git tracking status.

Final validation performed for this sub-phase: `tsc --noEmit` (apps/desktop + root, clean), full `vitest run` (58/59 passing — the one failure is a pre-existing missing local fixture, unrelated to any Phase 11 work), production build (succeeds), a 15-image large-batch run for both Universal Preprocessing and Ring & Bracelet (15/15 succeeded each), a live mid-batch cancellation test on the 15-image Universal Preprocessing batch (stopped cleanly at the next safe checkpoint, exit code 3, only the in-flight image's stage completed), a live recovery test (rerunning the interrupted batch correctly skipped the 1 already-done image and reprocessed the remaining 14), and a Watch-pipeline functional smoke test via the CLI. Could not launch the real Electron GUI in this environment (no `electron` binary available in this sandbox) — this has been a standing, disclosed limitation since Phase 11A; recommend a manual GUI smoke pass before this work is considered fully released.

Remaining technical debt carried forward (none blocking, none part of this run's approved scope):
* Directory naming — `preprocessing/UBG` and `preprocessing/RingBracelet` still don't reflect stage-oriented naming; never approved for this run given the path-reference risk.
* `RingBracelet/runner.py` has no idempotent-rerun skip (unlike Universal Preprocessing) — deliberately not added in 11E because its `detected` field is the output of the computation that would be skipped, and there's no way to recover it from disk without redoing that work.
* `sessionHandlers.ts`'s atomic-write logic remains its own inline copy rather than using the `atomicFile.ts` helper introduced in 11E — it was already crash-safe, so consolidating it was out of scope for a robustness-focused phase.
* The `ring_mask.py` vs `shank_mask.py` real-world discrepancy flagged during Phase 10G remains unresolved and un-investigated per your explicit instruction to stop that investigation — still an open question if ring-specific masking is ever revisited.
* `PROJECT_BRIEF.md` has substantial staleness that predates Phase 11 (it still describes a pre-Phase-9B navigation model, references the now-deleted `ModuleSelector`, and doesn't reflect the Batch-first registry model from Phase 9B onward) — out of scope for this phase's documentation update, which only added Phase 11's own architecture section; a dedicated documentation refresh pass would be needed to bring the rest of the document current.
* No automated GUI/E2E test coverage exists for any of the three pipelines end-to-end through the real Electron app — all Phase 11 validation of IPC/UI-adjacent behavior relied on unit tests plus direct subprocess-level verification, not a real Electron window (see the sandbox limitation above).

⸻

Phase 12 — AI-Assisted Watch Annotation & Boundary Detection

Goal

Introduce AI-assisted boundary detection for Watch annotation — first as a standardized provider abstraction decoupled from any specific detection method, then as a real AI prediction that pre-populates guides for user review.

Deliverables

Boundary Provider Interface

Standardize:

* leftBoundary
* rightBoundary
* boundarySource

Provider Abstraction

Support:

* Manual Provider
* AI Provider (future)

Metadata Support

Store:

* boundarySource
* confidence score

⸻

AI Boundary Provider

Generate:

* leftBoundary
* rightBoundary

Review Workflow

AI prediction
→ User review
→ Processing

Confidence Display

Display prediction confidence.

⸻

Success Criteria

* Processing engine no longer depends on manual annotation.
* Users spend significantly less time annotating.

⸻

Phase 13 — Earring Asset Generation

Goal

Introduce Earring asset generation as another product-specific asset generator built on the universal preprocessing pipeline established in Phase 10.

Deliverables

Processing Pipeline

* Upscale
* Background Removal
* Trim
* Resize to 2000px height while preserving aspect ratio

Output

* PNG
* Transparent background

Filename:

SKU;frontImage.png

Success Criteria

Earring imagery can be processed end-to-end into finished, production-ready assets using the same product-agnostic preprocessing foundation introduced in Phase 10.