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

Phase 11.5 — Workflow & Product Refinements

Goal

Build upon the architectural foundation established in Phase 11 by refining the end-user workflow across all editing pipelines. This phase focuses on improving consistency, usability, and maintainability before introducing new feature work in Phase 12.

The work is divided into incremental milestones covering preprocessing improvements, workflow standardization, batch management, quality assurance, and user experience polish.

⸻

Phase 11.5A — Background Removal Pipeline Modernization

Objective

Review and integrate the latest improvements to the Background Removal pipeline before expanding preprocessing workflows.

The /bg remove reference files are an algorithm and behaviour reference only, not an architectural replacement. The goal is not to replace the preprocessing architecture built during Phase 11 with the standalone reference scripts, but to extract and integrate their approved algorithmic and behavioural improvements into that existing architecture.

Scope

* Review the four updated Background Removal files located in the /bg remove directory.
* Compare the updated implementation against the existing pipeline.
* Identify behavioural improvements, architectural changes, and any potential regressions.
* Produce an integration proposal for review before implementation.
* After approval, integrate the approved algorithmic and behavioural improvements into the existing Phase 11 preprocessing architecture, preserving everything introduced during Phase 11 where applicable, including:
    * runner_base.py
    * electron_runner.py
    * the NDJSON protocol
    * cooperative cancellation
    * profiling
    * structured logging
    * heartbeat handling
    * MPS device support
    * the shared orchestration architecture
* Where the reference implementation regresses an already-solved problem (for example, its missing MPS device branch), preserve the existing, already-correct implementation rather than carrying the regression forward.

No workflow changes should be introduced until the updated Background Removal pipeline has been validated and integrated.

Deliverable

An updated Background Removal pipeline incorporating the approved improvements and serving as the new preprocessing baseline.

⸻

Background Removal Integration — Resolved Decisions

This subsection records the outcome of the integration proposal comparing `/bg remove`'s four reference files against the current pipeline (`config.py`, `stage0/background_remover.py`, `services/upscaler.py`), item by item, approved before any code was written.

1. **Device selection — reject the reference, preserve current behaviour.** The reference files select device via `cuda → cpu` only, with no MPS branch — a regression of an already-solved problem (see Phase 11's own MPS findings). Current code's `cuda → mps → cpu` selection in both `background_remover.py` and `upscaler.py` is preserved exactly, unchanged.
2. **FP16 precision policy — reject the reference, preserve current behaviour.** The reference only uses fp16 on CUDA, defaulting to fp32 on MPS/CPU. Current code uses fp16 unconditionally. Phase 11's validation and benchmarks were performed against current fp16-everywhere behaviour, with no evidence a precision-policy change would improve output or performance on this application's actual target hardware (Apple Silicon / MPS). Current behaviour is preserved unchanged.
3. **Adaptive analysis resolution — adopted.** BiRefNet's analysis resolution changes from a fixed 1024×1024 to `min(analysis_longest_side, image_longest_side)` rounded to a multiple of 32 — avoiding unnecessary upscale-then-analyze for inputs already smaller than 1024px on their longest side. This is a genuine, accepted improvement; it is the one change in this integration that is not fully output-preserving for that specific input-size range, and that tradeoff is accepted.
4. **New mask/edge parameter surface — adopted with behaviour-preserving defaults.** `mask_threshold`, `mask_contrast`, `mask_antialias_scale`, `alpha_sharpen`, and a new `edge_mode="crisp"` option are introduced now, defaulted to neutral/no-op values (`mask_contrast=1.0`, `mask_antialias_scale=1`, `alpha_sharpen=0`, `mask_threshold=None`, default `edge_mode` remains `"sharpen"`) so an unconfigured rerun produces the same output as before this integration. The reference implementation's own tuned values for these parameters are deliberately not adopted as defaults here — Phase 11.5B is where this parameter surface gets exposed and tuned through the preprocessing preset system. 11.5A must not silently change visual output.
5. **Adaptive upscale-by-image-size — rejected, out of scope for this phase.** The reference upscaler overrides the user's selected scale factor based on image dimensions (forcing 1× above a size threshold, 4× below another). This is explicitly rejected: the user's selected scale factor is the source of truth and must be applied exactly as selected, with no implicit override based on image dimensions. Current upscaling behaviour is preserved exactly — no scale-by-size logic is integrated. Adaptive upscaling may be revisited in the future as an explicit, separately-selected mode if there is sufficient demand; it is not part of Phase 11.5A and must not be introduced as hidden behaviour behind the existing scale selector.

⸻

Phase 11.5B — Preprocessing Presets

Objective

Replace low-level preprocessing configuration with user-friendly quality presets covering the entire preprocessing pipeline, while preserving the existing configurability internally.

This phase originally referred only to the SAM2 configuration, because SAM2 was the only configurable preprocessing stage at the time it was written. Following Phase 11.5A, the preprocessing pipeline contains additional tunable behaviour. Fast / Balanced / Quality must therefore represent complete preprocessing presets, not SAM2-only presets.

Scope

* Replace the current SAM2 configuration in the Settings page with configurable quality presets (e.g. Fast, Balanced, Quality).
* Each preset defines the complete set of underlying technical preprocessing parameters for that quality level — every tunable preprocessing behaviour, including SAM2 and any additional parameters introduced by Phase 11.5A's Background Removal integration — not SAM2 parameters alone.
* Introduce preset selection within the Preprocessing workflow.
* Preset selection is stored on a per-batch basis.
* Default all new batches to the Balanced preset.

The Settings page remains responsible for defining preset values across the entire preprocessing pipeline, while the Preprocessing workflow is responsible only for selecting between them.

Deliverable

A simplified preprocessing configuration workflow using reusable, complete-pipeline quality presets.

⸻

Preprocessing Presets — Approved Specification

This subsection is the authoritative source of truth for Phase 11.5B, approved before implementation.

These presets configure the preprocessing pipeline only. They do not change workflow behaviour, scale factor selection, product-specific logic, or orchestration.

General principles:
* Balanced is the default preset and serves as the regression anchor for the current production configuration.
* Fast reduces processing time by lowering analysis and sampling fidelity, while keeping finishing behaviour identical to Balanced.
* Quality enables the enhanced preprocessing capabilities introduced in 11.5A (crisp edge mode, alpha sharpening, mask contrast) while preserving the same underlying pipeline.
* User-selected upscale factor remains the source of truth and must never be overridden by a preset.
* Product workflows remain unchanged.
* No additional tuning is introduced beyond what is specified below. No silhouette-defining parameters change between presets beyond the approved values. Orchestration, IPC, batch persistence, and workflow behaviour are not modified by this phase.

| Parameter | Fast | Balanced (default) | Quality |
|---|---|---|---|
| analysis.longest_side | 768 | 1024 (existing production value) | 1024 |
| analysis.size_multiple | 32 | 32 (existing production value) | 32 |
| refine_foreground | false | false (existing production value) | false |
| mask_blur | 0 | 0 (existing production value) | 0 |
| mask_offset | -2 | -2 (existing production value) | -2 |
| mask_threshold | None | None (behaviour-preserving default) | None |
| mask_contrast | 1.0 | 1.0 (behaviour-preserving default) | 1.15 |
| mask_antialias_scale | 1 | 1 (behaviour-preserving default) | 1 |
| edge_mode | sharpen | sharpen (behaviour-preserving default) | crisp |
| edge_strength | 1.0 (matches Balanced — preserves identical finishing behaviour) | 1.0 (existing production value — see note below) | 1.5 (deliberately raised for this milestone — see note below) |
| alpha_sharpen | 0.0 | 0.0 (behaviour-preserving default) | 1.0 |
| SAM max_image_size | 768 | 1024 (existing production value) | 1024 |
| SAM points_per_side | 24 | 32 (existing production value) | 48 |
| SAM points_per_batch | 64 | 16 (existing production value — intentionally not raised to 64) | 64 |
| SAM pred_iou_thresh | 0.8 | 0.8 (existing production value) | 0.8 |
| SAM stability_score_thresh | 0.92 | 0.92 (existing production value) | 0.92 |
| SAM min_mask_region_area | 100 | 100 (existing production value) | 100 |
| SAM max_masks | 32 | 32 (existing production value) | 32 |
| SAM multimask_output | false | true (existing production value) | true |

Notes:
* Balanced's `points_per_batch` is deliberately kept at its existing production value (16) rather than raised to 64, even though 64 may be a valid optimization — Balanced's purpose is to stay as close as possible to today's validated production configuration, not to also carry a speculative improvement.
* `edge_strength`'s original value in this table (1.5 for all three presets) was corrected after implementation-time verification. The pre-11.5B renderer never actually sent `--edge-strength` (no UI control existed for it), so true historical production behaviour used the CLI's argparse default of **1.0**, not 1.5 as originally assumed. This was confirmed empirically: reconstructing the exact pre-11.5B payload and running it through the real pipeline produced byte-identical output to Balanced only when `edge_strength=1.0`; `1.5` diverged. Balanced and Fast now use `1.0` (Fast explicitly, to preserve identical finishing behaviour to Balanced per the general principles above). Quality intentionally raises `edge_strength` to `1.5` for this milestone, evaluated alongside its other changes (`crisp` edge mode, `alpha_sharpen`, `mask_contrast`) rather than in isolation from them.
* Every "behaviour-preserving default" value above is identical to the no-op default introduced in Phase 11.5A — Balanced and Fast never engage `mask_threshold`, `mask_antialias_scale`, or `alpha_sharpen` at all; only Quality does, and only for the two dimensions explicitly approved (`mask_contrast`, `alpha_sharpen`, `edge_mode`).

Phase 11.5B follow-up — Editable Preset Definitions

Approved before implementation. Restores the original design intent — Settings owns what Fast/Balanced/Quality mean; Preprocessing only selects between them — without reintroducing per-batch tuning.

* The values in `constants/preprocessingPresets.ts` (`DEFAULT_PREPROCESSING_PRESETS`) are the **factory defaults**, used to initialize the persisted definitions on first run and as the target of "Reset to default." They are no longer the live values consumed at run time.
* The **active preset definitions** — the values actually used to build CLI args — are persisted separately (`preprocessing-preset-definitions.json`), editable only from Settings. Preprocessing continues to send only a preset name; batch persistence continues to store only the preset name.
* Each preset definition carries a **version number**, incremented every time that preset is saved (including a "Reset to default," which is itself a save). Batch persistence records the preset name *and* the version that was active when the batch ran — lightweight provenance without snapshotting the full parameter set onto every batch. A batch's recorded version does not track further edits made to that preset after the batch ran; this is an accepted trade-off of storing only a name + version rather than a full snapshot.
* Settings shows a subtle "Using factory defaults" / "Modified" indicator for the currently-selected preset, computed by comparing its active values against `DEFAULT_PREPROCESSING_PRESETS` for that preset (not a separately-stored flag, so it can never drift out of sync with the actual values). "Reset to default" restores both the factory values and this status by saving the factory values back (incrementing the version, same as any other save).
* Because `buildArgs` in `preprocessHandlers.ts` is called synchronously when a job starts (`subprocessRunner.ts`'s contract), the main process holds the active definitions in an in-memory cache (mirroring `pythonResolver.ts`'s `_cached` pattern) hydrated once at app startup — before the window opens, before any job could start — and updated in place on every save.

⸻

Phase 11.5C — Automatic & Manual Processing Modes

Objective

Standardize processing modes across all editing pipelines through a shared Automatic / Manual workflow abstraction, implemented using shared infrastructure wherever practical rather than pipeline-specific implementations.

Automatic / Manual is a shared workflow abstraction, not an AI-specific toggle:

* **Automatic** means: use the product's automated masking workflow before continuing through the remainder of the editing pipeline.
* **Manual** means: masking has already been completed externally — skip the automated masking stage and continue with the downstream editing pipeline.

Scope

* Introduce an Automatic / Manual selector during batch creation for every editing pipeline.
* Store the selected mode as part of the batch configuration.
* Display the selected mode within the Batch Details page.
* For Ring & Bracelet generation:
    * Automatic performs the product's existing automated masking workflow before continuing.
    * Manual skips masking entirely and proceeds directly to the downstream editing pipeline.
    * Both modes must converge on the same downstream editing pipeline.
    * Apply shadow generation using a dedicated Ring & Bracelet shadow profile — see "Ring & Bracelet Shadow Generation" below for the resolved integration approach and settings. The goal is shared visual behaviour (same masking/falloff technique, product-specific tuning) rather than a single shared implementation at any cost.
* For Watch generation:
    * Manual continues to behave exactly as the current implementation.
    * Automatic establishes the workflow abstraction only; AI-driven Watch generation will be introduced during Phase 12.

The implementation should prioritize a shared workflow abstraction while allowing individual pipelines to retain their product-specific processing behaviour where that results in a simpler architecture (e.g. which masking algorithm Automatic invokes per product; how shadow generation is implemented per pipeline — see below).

Deliverable

A unified processing-mode workflow shared across all editing pipelines — including visually consistent, product-tuned shadow generation for Ring & Bracelet.

⸻

Ring & Bracelet Shadow Generation — Resolved Integration Approach

This subsection records the outcome of an explicit architecture investigation (two candidate approaches were compared before any code was written) and the resulting decision, so the reasoning survives independently of the chat history that produced it.

**Decision: port the shadow algorithm into the Python Ring & Bracelet pipeline. Do not introduce a new Python ↔ Electron processing boundary to reuse the TypeScript implementation.**

Two approaches were investigated:
1. **Reuse the existing TypeScript shadow engine** (`packages/processing/src/processing/shadowEngine.ts`) cross-process — Electron would read Python's output, invoke the TS engine, write the final file. Rejected: this pipeline runs start-to-finish in one Python process today, with no mid-flight handback to Node; introducing one would require extending the Phase 11B/11D shared subprocess orchestration, the batch status model, cancellation semantics, and Phase 11E's idempotent-rerun logic to account for a new intermediate ("masked but not yet shadowed") state — a nontrivial change to four already-stabilized subsystems, solely to avoid a second implementation of one self-contained, dependency-free image-processing function.
2. **Port the algorithm into Python.** Accepted. The underlying operations (alpha threshold, max-filter dilate, Gaussian blur, translate/offset, a horizontal gradient mask, hex-color compositing) are standard PIL/numpy operations — the same toolchain `RingBracelet/runner.py` and `shank_mask.py` already use for comparable alpha-channel work. No new dependency, no new process model. The cost is verification, not implementation risk: the port must be checked against the existing TS engine's output (matching settings, representative test images, direct pixel comparison) before being considered equivalent — this is a required validation step for this milestone, not optional polish.

The existing TypeScript shadow engine (`shadowEngine.ts`) is not modified by this work and remains the Watch pipeline's implementation, unchanged.

**Masking/falloff technique is preserved, not simplified.** Ring & Bracelet shadows use the same masked-shadow approach as Watch — including the horizontal fade-in/fade-out falloff (`maskAlphaAtX` in the TS original) — not a uniform, unmasked drop shadow. The difference between Watch and Ring & Bracelet shadows is tuning, not technique.

One necessary generalization: the TS original's falloff breakpoints (100 / 400 / 1600 / 1900) are absolute pixel values assuming a fixed 2000×2000 canvas, which Ring & Bracelet images do not use (their dimensions vary per image, driven by upstream preprocessing/upscaling). The Python port expresses these breakpoints proportionally — 5% / 20% / 80% / 95% of the image's actual width — preserving the same relative falloff shape (fade in over the first 15% of width, full strength through the middle 60%, fade out over the last 15%) at whatever size the image actually is, rather than reproducing the literal pixel values out of context.

**Ring & Bracelet has its own named shadow profile** (e.g. a `RING_BRACELET_SHADOW` settings constant, distinct from Watch's `defaultShadowSettings`) — not a shared settings object with override fields. The two profiles use the same underlying shadow algorithm and the same masking/falloff behaviour, but are independently defined and independently tunable: future tuning of one profile must not unintentionally affect the other. This is a straightforward consequence of porting the algorithm as a parameterized function and supplying two separate settings values to it — not two separate algorithm implementations, just two separate config values, kept structurally independent rather than one deriving from or partially overriding the other.

**Ring & Bracelet shadow profile — confirmed values** (mapped from the supplied Photoshop-style layer-style values into the engine's parameter shape; all values below are approved, not provisional):

| Photoshop-style input | Engine parameter | Value | Note |
|---|---|---|---|
| Blend Mode: Normal | — | — | No parameter needed — the engine already composites a solid-color layer through an alpha mask, equivalent to Normal blend; nothing to configure. |
| Color: #2e170a | `color` | `"#2e170a"` | Same value as Watch's own default. |
| Opacity: 30% | `opacity` | `0.3` | Same value as Watch's own default. |
| Angle: 90°, Distance: 50px | `xOffset`, `yOffset` | `0`, `50` | Approved. Photoshop angle convention: 90° = light from directly above → shadow cast straight down, which is positive Y in image pixel space. Same direction as Watch's own default (`yOffset: 54`), different magnitude. |
| Spread: 0% | `spread` | `0` | Direct mapping. |
| Size (Blur): 40px | `blurRadius` | `40` | Direct mapping. |
| *(not specified)* | `density` | `1.75` | Approved as an intentional design decision: the Ring & Bracelet profile uses the same density value as Watch's existing shadow profile, to preserve the current visual language. This does not require additional tuning or validation — it is a deliberate match, not a placeholder. |

**Application scope:** the shadow is applied only to the final asset image, never to intermediate masks or auxiliary assets:
* **Automatic mode:** applied to the generated `frontImage` (the masked asset) after the automated masking workflow completes — not to `frontFullImage`, which remains an unmodified reference copy of the preprocessed input, as it is today.
* **Manual mode:** applied to the single per-SKU input image provided (already background-removed and manually prepared) — there is no internal masking step to wait for in this mode.
* **Confirmed: Manual mode preserves the existing output contract exactly.** `frontFullImage` remains the untouched reference copy of the as-provided input; `frontImage` is that same image with the shadow applied. The output schema (field names, shape, meaning) is identical regardless of processing mode — Automatic and Manual differ only in whether an automated masking step runs before the shadow step, never in what fields the pipeline emits.

**Follow-up refinement — canvas compositing to eliminate shadow clipping.** The initial implementation generated the shadow directly on the tightly-cropped working image, which could clip the shadow against the image's own edges (confirmed empirically: a downward-offset, blurred shadow extended to within a few pixels of a test image's bottom edge). Resolved by adopting the same canvas approach Watch's `exportEngine.ts` uses: the working image is centered on a temporary transparent canvas (`max(2000, image width/height + 200px margin)` — 2000 for consistency with Watch's own canvas size, growing only if the image itself would exceed that), the shadow is generated on that padded canvas so blur/offset have unclipped room in every direction, the subject is composited back over the shadow, and the result is auto-trimmed to its non-transparent content bounds on all four sides before export (Watch's `trimTransparentTopBottom` trims top/bottom only, since Watch's canvas width *is* its fixed output width by design; Ring & Bracelet has no such fixed-width contract, so trimming reclaims padding on every side). The horizontal falloff breakpoints remain proportional to the *working image's own width*, not the padded canvas width — computed relative to the subject's position on the canvas — so padding never changes the falloff's shape, only how much room exists around it. `frontFullImage` is unaffected (produced before any of this, from the unmodified input). `frontImage`'s exported dimensions may now differ slightly from the pre-shadow crop — larger where the shadow needed room, potentially smaller where the original crop had unused transparent margin neither the subject nor its shadow occupy — this is the intended effect of trimming to actual content rather than an unexpected side effect. Ring & Bracelet's shadow profile (`RING_BRACELET_SHADOW`) remains fully independent of Watch's `defaultShadowSettings`; only the compositing *approach* is now shared, not the tuning.

⸻

Phase 11.5D — Batch Persistence Expansion

Objective

Extend the existing batch persistence architecture beyond Watches to all editing pipelines.

Scope

* Extend batch discovery, validation, restoration, and resume functionality to Rings, Bracelets, and future editing workflows.
* Maintain the existing Watch batch persistence behaviour while generalizing the underlying infrastructure.
* Persist batch configuration, processing mode, preprocessing preset, and progress.
* Manual editing batches must support interruption and resume.
* Automatic processing should preserve progress wherever practical, while allowing implementation details to be determined during development if technical constraints arise.

The user experience should remain consistent regardless of product type.

Deliverable

A unified batch persistence and recovery system shared across every editing pipeline.

Resolved scope (approved before implementation, after a research pass into current behavior):

1. **Idempotent reruns for Ring & Bracelet** (`runner.py`) — mirrors `electron_runner.py`'s existing Phase 11E behavior exactly: an image whose expected outputs already exist is skipped and reported complete rather than reprocessed.
2. **Incremental progress persistence** (`subprocessRunner.ts`, `subprocessProtocol.ts`) — the canonical fix. Previously, per-image results only reached the batch registry once, in the process-close handler; a crash or force-quit mid-batch lost all progress from that run, even images that had genuinely finished. Progress (`images`/`counts`) is now persisted to the registry after every per-image `complete`/`error` event, serialized through a per-job promise queue (`job.persistQueue`) so concurrent registry writes — which have no locking of their own — can never race and silently drop an update. This is shared infrastructure, so it applies uniformly to Preprocessing and Ring & Bracelet (and any future editing pipeline) without pipeline-specific work.
3. **Lightweight pre-flight validation for Ring & Bracelet** (`ring-bracelet:validate-input`) — checks the input folder exists and contains at least one supported image before Start is enabled, matching the spirit of Watch's `batch:validate` without its spreadsheet/SKU-matching (Ring & Bracelet has neither) and without requiring the output folder to pre-exist (`runner.py` creates it).

**Deferred to a follow-up**: a "Resume" action on Batch Details that restarts a failed/cancelled batch against its own already-recorded folders instead of routing to a disconnected "Run Another." Deferred deliberately — items 1–2 above are most of the infrastructure such an action would need, and reviewing that foundation first was preferred over adding new navigation/workflow state in the same pass.

**Explicitly out of scope**: Watch's existing session-based interruption/resume is unchanged — this phase does not introduce new Watch-specific workflow behavior.

**Persistence guarantee** (architectural note, see `subprocessRunner.ts`'s module docstring for the full version): once a runner's per-image terminal event (`complete` or `error`) has been processed, that image's result is written to the batch registry before the next event is handled, not deferred to process close — so an unexpected interruption loses at most the one image in flight, never previously-completed work. Combined with each runner's idempotent-rerun behavior, a subsequent rerun against the same output directory reuses that already-persisted work rather than redoing it. This is why a future "Resume" action can be a thin orchestration layer on top of already-durable state, rather than infrastructure in its own right.

⸻

Phase 11.5E — Manual Quality Review Workflow

Objective

Introduce a lightweight quality-assurance workflow for manual editing pipelines without disrupting overall batch progress.

Scope

* Introduce a Needs Fixing status for manually reviewed assets.
* Allow assets to be marked as Needs Fixing during manual review.
* Assets marked Needs Fixing:
    * remain associated with the batch,
    * are excluded from completed totals,
    * appear within a dedicated section on the Batch Details page,
    * retain their status across application restarts and resumed sessions.
* This workflow must be non-destructive and must not delete or remove assets from the batch.

This provides a lightweight QA process for identifying assets requiring further work while allowing the remainder of the batch to continue uninterrupted.

Deliverable

A persistent quality-review workflow integrated into all manual editing pipelines.

Resolved scope (approved before implementation, after a research pass into current Batch Details architecture):

* **Needs Fixing is an orthogonal flag, not a new processing status.** `StageImageRecord.status` (`completed`/`failed`/`cancelled`) still describes whether the pipeline itself succeeded; `needsFixing` is a separate, human-set boolean layered on top, toggleable only on an already-`completed` image. This is a workflow concern, not a persistence concern — the flag lives wherever the underlying image record already lives, rather than inventing a parallel state machine.
* **Scoped to Ring & Bracelet (the `editing` stage type) for this pass.** Research found two genuinely different persistence models behind the same-looking Batch Details UI: Preprocessing and Editing store per-image results as `StageImageRecord[]` in the batch registry; Watch has no registry-backed images at all — its Batch Details view is synthesized on every render from `SessionFile` (`session:save`/`session:load`), a different shape entirely. Proving the concept on the registry-backed model first, then bringing the same *experience* to Watch's session model as its own follow-up, avoids forcing both persistence systems to evolve together in one pass. Preprocessing is excluded entirely — it isn't an editing pipeline and has no manual-review concept today.
* `StageCounts` gains a `needsFixing` count; `succeeded` no longer includes flagged images, so the existing counts continue to sum to `total`.
* A dedicated "Needs Fixing" section on Batch Details, and a distinct badge on the existing thumbnail grid (flagged images remain visible everywhere they already appeared — nothing is hidden or removed, only excluded from the numeric completed count).

⸻

Phase 11.5F — User Experience Polish

Objective

Improve terminology and clarity within the preprocessing workflow.

Scope

* Rename the preprocessing Upscaling option currently labelled 1× to None.
* Preserve all existing functionality.
* No behavioural changes are introduced.

Deliverable

A clearer preprocessing interface with improved user-facing terminology.

Implemented as a label-only change: the Preprocessing screen's Upscale Factor selector and its accompanying helper text. Also extended, for consistency, to Batch Details' Configuration summary — the same scaleFactor value is displayed there too, and leaving it as "1×" while the selector now says "None" would have reintroduced the exact inconsistency this phase exists to remove. The underlying `UpscaleFactor` value, CLI arguments, and Python upscale behavior are all unchanged.

⸻

Phase 12 — Earring Asset Generation

Goal

Introduce Earring asset generation as another product-specific asset generator built on the universal preprocessing pipeline established in Phase 10.

The implementation should extend the shared preprocessing architecture with an earring-specific editing pipeline capable of generating production-ready assets for multiple earring styles while maintaining consistency with the application’s existing processing workflows.

Deliverables

Processing Pipeline

All earring images should pass through the shared preprocessing pipeline:

* Optional Upscale
* Background Removal
* Trim
* Resize to 1000px height while preserving aspect ratio (corrected from an earlier 2000px draft — the earring shadow profiles are designed around a 1000×1000 working canvas; see Resolved Decisions below)

Upon continuing to editing, images should enter an earring-specific asset generation workflow.

Processing Modes

Support two processing modes:

* Automatic — computer vision performs any required segmentation or split detection.
* Manual — user provides the required editing input where applicable.

Earring Types

Support three earring categories:

Stud

* Shadow applied to the full earring silhouette.
* Generates:
    * SKU;compare.png
    * SKU;frontImage.png

Drop

* Shadow generated only from the upper anchor region (approximately the upper 10% of the earring), preventing shadows from extending unrealistically along the hanging portion.
* Generates:
    * SKU;compare.png
    * SKU;frontImage.png

Hoop

Support both Automatic and Manual editing.

Automatic:

* Detect the front/rear split using a computer vision approach analogous to the existing bracelet segmentation pipeline, adapted for vertically-oriented earrings.

Manual:

* Allow the user to position a single split boundary defining the front portion of the hoop.

Generate:

* SKU;compare.png
* SKU;frontFullImage.png
* SKU;frontImage.png

frontImage should preserve the exact canvas dimensions of frontFullImage; the rear portion of the hoop should become transparent rather than being cropped, ensuring both assets remain perfectly aligned.

Shadow Generation

Apply Photoshop-equivalent drop shadows using the existing shadow generation architecture.

Default shadow profile:

* Blend Mode: Normal
* Opacity: 40%
* Angle: 90°
* Distance: 20 px
* Spread: 30%
* Size: 24 px

Shadow casting region:

* Stud: Entire silhouette
* Drop: Upper anchor region (~10%)
* Hoop: Upper anchor region (~10%) after front-half isolation

Output

All generated assets should be PNGs with transparent backgrounds.

Outputs vary by earring type:

Stud / Drop

* SKU;compare.png
* SKU;frontImage.png

Hoop

* SKU;compare.png
* SKU;frontFullImage.png
* SKU;frontImage.png

Architectural Rules

* compare represents the immutable output of Universal Background Removal followed by trimming.
* All editing operations derive from compare.
* frontImage is always the edited production asset.
* For Hoop earrings, frontFullImage is an unmodified duplicate of compare, retained for downstream Virtual Try-On usage.
* Product-specific editing must never modify the canonical compare asset.

⸻

Phase 12 — Resolved Decisions

Approved before implementation. These decisions supersede any conflicting wording in the phase text above.

1. **Earring classification comes from a product metadata sheet, not a UI selector.** The user supplies a CSV/XLSX sheet with columns: SKU, Category, Sub-Category, Dimensions. This is designed as a **generic product-metadata system** (future products reuse the same parser, matching, and persistence), not an earring-specific feature. The earring type (Stud / Drop / Hoop) is derived per SKU from the normalized Sub-Category at validation time; unrecognized values are reported explicitly in the match summary, never silently defaulted. Dimensions are parsed and persisted with the batch but are **not** consumed by the processing pipeline — stored for future use only. A consequence embraced deliberately: batches are mixed-type by default, and the runner dispatches per image by resolved type, not per batch.
2. **Resize target is 1000px height** (not 2000px as originally drafted). The earring shadow profiles and compositing canvas are designed around a 1000×1000 basis; the earring canvas base is 1000 accordingly (Ring & Bracelet's 2000 base is unchanged).
3. **compare is created after the complete shared preprocessing chain** (background removal → trim → resize-to-1000). It is the immutable image immediately before any masking or shadow generation, equals the editing stage's input exactly, and every editing operation derives from it.
4. **Hoop's alignment contract outranks Ring/Bracelet compositing parity.** Hoop `frontImage` is composited on the fixed compare-sized canvas with **no post-shadow trim**, guaranteeing byte-identical canvas dimensions to `frontFullImage`; minor shadow edge-clipping is accepted. Stud and Drop, which carry no alignment constraint, use the shared canvas-composite-then-trim approach (with the 1000px canvas base). Shared rendering infrastructure is reused; behavior diverges only where this contract requires it.
5. **Shadow profile:** same color (`#2e170a`) and density (`1.75`) as the existing Watch and Ring & Bracelet profiles; Opacity 40% → `0.3`-style direct mapping (`0.4`); Angle 90° + Distance 20px → offset `(0, 20)`; Size 24px → blur radius `24`. **Spread mapping (resolved during 12C, recorded here per this decision's own instruction):** the engine's `spread` field has always been a raw pixel dilation radius, never a percentage — Ring & Bracelet's own Spread is 0%, where the unit ambiguity never mattered. Earring's Spread: 30% is the first nonzero case, so the approved convention is `spread_px = round(size_px × spread_percent)` — for this profile, `round(24 × 0.30) = 7`. Any future profile with a nonzero Spread follows the same formula. **The horizontal falloff is not applied to earrings.** Falloff becomes a per-profile capability (`horizontal_falloff`, default enabled so Ring & Bracelet output is bit-for-bit unchanged), disabled in the earring profile. Earrings use only the vertical casting-region restriction: full silhouette for Stud, top ~10% anchor region for Drop and Hoop.
6. **Hoop automatic detection is an earring-owned module** (`preprocessing/Earring/hoop_mask.py`) — inspired by the bracelet topology approach but implemented and tuned independently, per the Phase 10E lesson that cross-product reuse of silhouette algorithms fails on new geometry. It keeps the established `(mask, detected)` contract so low-confidence results route to review.
7. **Processing modes:** Stud and Drop behave identically in Automatic and Manual modes (they have no masking step; both modes converge on shadow generation, mirroring Ring & Bracelet's mode semantics). Only Hoop differs: Automatic runs `hoop_mask`; Manual collects one user-placed split boundary per hoop SKU in-app before the batch runs.

⸻

Phase 12 — Hoop Detection: Decision Record (Phase 12D/12E)

Recorded per Phase 12F's documentation requirement — the decisions actually made during 12D/12E's architecture approvals, not restated from the phase text above.

* **`hoop_mask.py` is an intentional placeholder, not a tuned detector, and remains one at the close of Phase 12.** No real hoop photography existed at 12D's start or at 12F's close (checked again during 12F; still none in the repository). Per the Phase 10E precedent this phase itself invokes (Resolved Decision 6), the algorithm was deliberately not pre-specified — 12D built the full contract and integration (runner.py's hoop branch, dimension-parity assertion, NDJSON/`detected` plumbing, UI badge/review routing) around a structural stand-in rather than block the rest of the roadmap on unavailable assets. `generate_hoop_mask` always returns `detected=False`, so every Automatic Hoop result routes to manual review honestly rather than reporting confidence it doesn't have.
* **The split is a single vertical boundary** — one x-position (not a per-row-varying curve like `shank_mask.py`'s bracelet cut) — separating the hoop's bounding box into a left (front) and right (rear) portion. Confirmed explicitly during 12D's architecture approval; carried through unchanged into 12E's manual editor, which lets the operator drag that same single value directly.
* **Mask edge is the same soft sigmoid transition** `shank_mask.py`/`ring_mask.py` already use (~1.5% of the subject's own bounding-box extent) — approved as a deliberate non-decision: no reason to introduce a second edge style before real photography suggests one is needed.
* **`EDGE_SAFE_FRACTION = 0.15`** — a structural clamp (mirroring `ring_mask.py`'s `CROWN_SAFE_FRACTION`) preventing the split, automatic or manual, from landing within 15% of the bounding box's own edges. Applied identically by both modes since both converge on `hoop_mask.build_mask_from_split_x` (12E) — the shared rendering step extracted specifically so Automatic and Manual could never silently drift into two different-looking results. This convergence is now regression-locked by `tests/earringRunnerIntegration.test.ts` (12F), which asserts byte-identical `frontImage` output for the two paths given the same resolved split position.
* **Follow-up work, deferred pending representative production photography** (see Debt Register below): replace `vertical_split_x`'s bbox-midpoint estimate with a real detector; revisit whether the vertical-boundary model itself holds up across hoop styles (thin wire, thick huggie, textured/openwork) once real images can be reviewed.

⸻

Phase 12 — Debt Register (for the next Architecture Strengthening run)

* **Hoop CV tuning** — `hoop_mask.py`'s placeholder detector needs to be replaced with a real one once representative production hoop photography is available (blocked since 12D; still blocked at 12F's close). See the decision record above for exactly what's already fixed (contract, orientation, edge treatment, safety clamp) versus what the real algorithm still needs to determine (the actual split-finding logic).
* **Earring shadow verification against Photoshop-produced references** — 12F's own validation checklist called for this (1000×1000, all three types); no reference images exist in the repository. Deferred until reference assets are supplied; not attempted from assumptions.
* **UBG user documentation** (`preprocessing/UBG/docs/*.docx`) — these are Word binaries outside this codebase's normal review/editing tooling. Phase 12 (metadata sheet requirement, resize-to-1000, Stud/Drop/Hoop workflows) changed preprocessing-facing behavior these manuals describe; updating them is an external documentation task for whoever maintains that manual, not completed as part of Phase 12.
* **Metadata system extension to other products** — `packages/processing/src/data/productMetadata.ts` (Phase 12B) was deliberately built product-agnostic; Earring is its first consumer, not the reason it exists. Extending it to other product types is unscoped future work.
* **Horizontal falloff visual reassessment** — `horizontal_falloff` became a per-profile capability in 12C (on by default for Ring & Bracelet parity, off for Earring per Resolved Decision 5). Whether Earring should ever want a falloff-like visual treatment of its own has not been revisited since.
* **`discoverImages` is PNG-only; Earring's runner/validation also accept `.webp`.** `packages/processing/src/data/imageDiscovery.ts` (pre-Phase-12, reused as-is for the generic metadata system per 12B) only matches `.png` files, while `Earring/runner.py` and `earring:validate-input` both accept `.webp` too. In practice nothing upstream (Universal Preprocessing's earring plugin, the resize-to-1000 step) ever produces `.webp` earring input, so this is dormant, not exercised — but a `.webp` earring image would silently never match against the metadata sheet (appearing as "missing metadata record") even if a sidecar entry existed for it. Noted rather than fixed in 12F, since the shared discovery function is Watch-matching infrastructure predating Phase 12, out of this phase's scope to change.
* **Temp sidecar file accumulation** — `earringHandlers.ts` writes a new metadata/splits sidecar JSON to `app.getPath('temp')` on every `earring:start` (each is tiny, but nothing prunes them, unlike `pruneOldLogs`'s precedent for logs). Very low priority given file size and OS temp-directory hygiene, noted for completeness.
* **Multithreaded Ring & Bracelet processing** — explored and abandoned mid-session (2026-07-31) after profiling showed the actual bottleneck (`composite_with_shadow`'s Gaussian blur / density dilation on a padded 2000×2000 canvas) does not release the GIL enough under the Pillow build in use to yield real wall-clock improvement from a thread pool; all code from that attempt was reverted. Noted here so a future attempt starts from that finding (a process pool, or profiling a different Pillow/OpenCV build, would be the next things to check) rather than re-discovering it.
* **`trim_output` capability flag removed from `shadow.py`** — added in 12C alongside `composite_with_shadow`'s other per-profile capability flags, anticipating that Hoop would need an untrimmed output. Hoop's actual 12D/12E architecture (Resolved Decision 4) bypassed `composite_with_shadow` entirely, calling `create_drop_shadow()` directly on an unpadded, already-compare-sized canvas — so the flag was never exercised by any real caller. Removed in the Phase 12A–12F final-consistency pass (post-12F); `composite_with_shadow` now always trims, matching every real caller's actual usage. Golden regression gate (`tests/shadowEngineRegression.test.ts`) re-confirmed byte-identical after removal.

⸻

Phase 12 — Approved Execution Plan (12A–12F)

Each sub-phase follows the standard ritual (architecture → files → risks → approval → implement → explain/test → stop) and is independently testable. Mechanical gates for every sub-phase: `npx tsc --noEmit` (apps/desktop and repo root where applicable), `npx vitest run`, `python -m py_compile` for every touched Python file.

**12A — Preprocessing reach & hand-off resize**

* New `preprocessing/UBG/plugins/earring.py` — trivial plugin, `requires_masks: False` (the established one-file extension point; no changes to `electron_runner.py` or services).
* `ProductType` union and `PRODUCT_TYPE_OPTIONS` gain `earring` (`apps/desktop/src/types/ipc.ts`, `screens/Preprocessing.tsx`).
* `electron/services/workflowPreparation.ts` gains an optional `resizeToHeight` step applied after the existing trim (sharp, aspect-preserving, resizes in both directions to normalize the canvas basis). `EditingHandoffDialog.tsx` + hand-off payload types extended; the earring hand-off configuration is trim = on, rotate = none, resize = 1000.
* Validation: earring hand-off output is exactly 1000px tall with aspect preserved; Watch hand-off output unchanged (regression check).

**12B — Generic product metadata system**

* New additive module in the existing data layer: `packages/processing/src/data/productMetadata.ts` — CSV/XLSX parsing with normalized headers (SKU / Category / Sub-Category / Dimensions), duplicate detection, and a match summary against discovered images with the same shape as Watch's (matched / missingImages / missingRecords / duplicates). **No existing data-layer or engine file is modified** — additive only, plus index re-exports.
* Earring classification mapping (normalized Sub-Category → Stud/Drop/Hoop, with an explicit unmapped list) lives app-side, not in the generic package.
* New thin IPC surface (`electron/ipc/metadataHandlers.ts`, one concern per file): load + match + classify, returning the summary for the setup screen. Types added to `types/ipc.ts`.
* New `tests/metadataLayer.test.ts` with CSV and XLSX fixtures covering parser, matcher, and classifier (pure functions, following `dataLayer.test.ts`'s pattern).

**12C — Stud & Drop end-to-end**

* **Shadow promotion:** move `preprocessing/RingBracelet/shadow.py` to `preprocessing/shadow.py` (beside `runner_base.py`); update the Ring & Bracelet import. Gate: Ring & Bracelet golden-image regression — byte-identical output before/after the move.
* **Shadow extensions (all parameterized with defaults preserving current Ring & Bracelet behavior exactly):** `horizontal_falloff` (default on), `casting_region` (optional top-fraction source-alpha clip, default none), `canvas_base` (default 2000), `trim_output` (default on). `EARRING_SHADOW` profile per Resolved Decision 5, including the confirmed Spread mapping recorded back into this document.
* **New `preprocessing/Earring/runner.py`** on `runner_base`: CLI `--input-dir/--output-dir/--metadata-file/--processing-mode` (`--splits-file` reserved for 12E). Per image: resolve type from the metadata sidecar; write `SKU;compare.png` (verbatim copy of input); Stud → shadow over full silhouette; Drop → shadow with `casting_region 0.10`; Hoop → per-image error "hoop not supported until 12D" (keeps mixed batches running honestly). Idempotent rerun via per-type expected-output sets; NDJSON `complete` events carry asset paths.
* **Electron:** new `electron/ipc/earringHandlers.ts` via the shared subprocess-runner factory (stage type `editing`): `earring:start/cancel/validate-input`; the main process writes the per-SKU resolved-type metadata sidecar to an app-owned temp location before spawn; stage config records `{ product: 'earring', metadataPath, processingMode, preset }`; registration in `main.ts`.
* **Renderer:** `EditingProduct` gains `'earring'`; `EditingSetup.tsx` earring branch (folder fields + metadata sheet `PathField` + match summary incl. per-type counts and unmapped SKUs + existing mode selector); new `useEarringFolders` hook + prefs pair (`earring-folders.json`, one-file-per-concern); earring job context via the `createJobContext` factory; thin `EarringRunWorkspace` + `EarringBatchSync` instantiations reusing the shared components; `App.tsx` earring branches mirroring ring/bracelet; Batch Details renders the editing stage generically (verify asset naming and config rows display).
* Validation: mixed-sheet batch end-to-end (stud + drop succeed, hoop rows produce visible per-image errors); rerun idempotency; force-quit mid-batch resume (incremental persistence); Ring & Bracelet regression gate.

**12D — Hoop Automatic**

* New earring-owned `preprocessing/Earring/hoop_mask.py`. Required process step, per the Phase 10E precedent: an algorithm proposal validated against real hoop photography is reviewed **before** implementation — the execution plan deliberately does not pre-specify unvalidated CV. Contract: `(mask, detected)`, bbox-relative constants, a safety clamp guarding the anchor region.
* `runner.py` hoop branch: `frontFullImage` = duplicate of compare; `frontImage` = rear made transparent (never cropped) + shadow with top-anchor casting region, composited on the fixed compare-sized canvas with no trim; a hard runtime assertion that `frontImage`, `frontFullImage`, and compare dimensions are identical; `detected` propagated through NDJSON and persisted (surfaced as a badge; Needs Fixing remains human-set, per 11.5E).
* Validation: real hoop set across styles (thin wire, thick huggie, textured/openwork); alignment assertion across the whole batch; visual review; `detected=False` routing sanity.

**12E — Hoop Manual**

* New single-boundary placement UI (purpose-built small component — deliberately not a reuse of the Watch `AnnotationCanvas`): a per-hoop-SKU loop showing the compare image with one draggable horizontal split line; the normalized split value is persisted per SKU into the batch stage record as it is placed, so annotation survives interruption and resumes (11.5D requirement). Flow: Manual mode + hoops present → boundary screen after validation → run; zero hoops → straight to run (identical to Automatic, per Resolved Decision 7).
* Runner consumes `--splits-file` (JSON, SKU → normalized split). The front/rear polarity convention must be documented in both the UI and `runner.py`. A hoop missing its split in manual mode is a per-image error, not a batch failure.
* Validation: annotate → quit → relaunch → resume drill; manual vs automatic output comparison on the same images.

**12F — Validation & hardening**

* Final Ring & Bracelet golden regression; earring shadow verification against Photoshop-produced references (1000×1000, all three types); large mixed-type batch (100+ images); Needs Fixing workflow exercised on earring outputs; crash-resume and idempotent-rerun drills repeated at scale.
* Documentation: PROJECT_BRIEF.md (new product, metadata system, shadow-profile capability changes), UBG user docs where preprocessing-facing behavior changed, and this plan updated with any decisions resolved during implementation (Spread mapping, hoop algorithm decision record).
* Debt register for the next Architecture Strengthening run: metadata system extension to other products, hoop CV tuning backlog, falloff visual reassessment.

**Outcome:** Ring & Bracelet golden regression re-confirmed passing. Photoshop shadow-reference verification and hoop CV tuning both deferred — no reference assets exist for either, per explicit decision rather than oversight (see the Decision Record and Debt Register above). Large mixed-type batch (100+ images), crash-resume at scale, and Needs Fixing on real Earring outputs were run as one-time manual hardening drills rather than added to the permanent automated suite, to keep `npx vitest run` fast — results reported in the 12F completion summary, not as new test files. A new permanent test, `tests/earringRunnerIntegration.test.ts`, was added covering incremental persistence, idempotent reruns, mixed-type dispatch, and — the specific regression lock this phase asked for — byte-identical `frontImage` output between Hoop Automatic and Hoop Manual when resolved to the same split position, proving both paths render through `hoop_mask.build_mask_from_split_x` and not two implementations that could silently drift apart. PROJECT_BRIEF.md rewritten (Earring's phase numbering and pipeline description were stale, describing an earlier, superseded draft of the product). UBG `.docx` docs intentionally not edited — recorded as an external documentation task above.

⸻

Success Criteria

Earring imagery can be processed end-to-end into production-ready assets using the same universal preprocessing architecture as other supported products while providing dedicated editing workflows for Stud, Drop, and Hoop earrings. Automatic and Manual processing modes should integrate seamlessly with the existing batch processing, persistence, and review infrastructure established in earlier phases.

⸻

Phase 13 — UX Modernization

Goal

Transform the application from a functional internal production tool into a polished, premium creative application with a modern AI-first user experience.

This phase focuses entirely on the user interface and user experience. Existing functionality should remain intact while the application’s visual language, interaction design, and overall usability are comprehensively reimagined.

The objective is to create software that feels intelligent, responsive, and enjoyable to use for extended editing sessions.

⸻

Deliverables

Design System

Develop a cohesive visual design system shared across the entire application.

This includes:

* Unified spacing and layout system
* Consistent typography hierarchy
* Standardized iconography
* Unified color palette
* Shared component library
* Consistent corner radii
* Refined elevation and depth system
* Design tokens for colors, spacing, animation, and effects

The interface should feel coherent rather than assembled from individual screens.

⸻

Visual Language

Replace the current flat interface with a richer visual aesthetic inspired by modern creative software.

Introduce:

* Layered glass surfaces
* Soft translucency
* Subtle blur effects
* Premium shadows
* Depth through layered surfaces
* Softer contrast
* Improved visual hierarchy
* Increased whitespace
* More breathable layouts

The application should feel refined while remaining highly functional.

⸻

Ambient Environment

Replace the static background with a subtle animated environment that gives the application a sense of life without becoming distracting.

Possible elements include:

* Animated ultraviolet gradients
* Pixelated ambient fields
* Soft pulsing illumination
* Slow-moving particles
* Procedural noise
* Dynamic lighting
* Gentle parallax

The animation should remain understated, serving as atmosphere rather than visual spectacle.

⸻

Motion System

Introduce a consistent motion language throughout the application.

This includes:

* Smooth page transitions
* Animated panel transitions
* Refined hover interactions
* Spring-based microinteractions
* Animated progress indicators
* Loading skeletons
* Success and completion animations
* Animated batch creation and deletion
* Fluid expanding and collapsing sections

Motion should communicate hierarchy, feedback, and application state rather than exist solely for decoration.

⸻

Batch Experience

Modernize the batch management experience.

Potential improvements include:

* Richer processing cards
* Better queue visualization
* More expressive progress indicators
* Live processing feedback
* Improved status presentation
* Clearer hierarchy between active and completed batches
* Better organization of historical batches

Processing should feel active and continuously progressing.

⸻

Image Review Experience

Refine the editing and review workflow.

Improve:

* Image preview presentation
* Thumbnail grid layout
* Selection behavior
* Compare/front image visualization
* Manual editing interactions
* Zooming and panning
* Image transition animations
* Batch review flow

The review experience should feel responsive and effortless.

⸻

Navigation

Modernize the application’s navigation and overall layout.

Potential improvements include:

* Refined sidebar
* Better page transitions
* Improved information architecture
* Clearer screen hierarchy
* Reduced visual clutter
* Faster navigation between workflows

⸻

Component Modernization

Redesign every major interface component.

Including:

* Buttons
* Cards
* Dialogs
* Forms
* Segmented controls
* Dropdowns
* Progress bars
* Notifications
* Context menus
* Batch cards
* Preview panels
* Status indicators

Every component should share a consistent visual identity.

⸻

Color System

Introduce a refined color palette centered around premium dark surfaces and restrained accent colors.

Examples include:

* Deep charcoal backgrounds
* Layered graphite surfaces
* Ultraviolet accent lighting
* Soft cyan highlights
* Carefully balanced semantic colors
* Reduced reliance on stark white

The application should avoid harsh black-and-white contrast in favor of richer tonal variation.

⸻

Accessibility

Improve usability without compromising the visual direction.

Focus on:

* Clear typography hierarchy
* Consistent contrast ratios
* Readable spacing
* Predictable interactions
* Keyboard accessibility
* Improved focus indicators

⸻

Performance

Maintain a fluid user experience throughout the visual overhaul.

Animation and effects should remain lightweight and responsive.

Visual enhancements must not noticeably impact processing performance or application responsiveness.

⸻

Success Criteria

The application should feel like a mature creative product rather than an internal utility. Every screen should exhibit a consistent design language, thoughtful motion, and refined interaction design while preserving the speed and efficiency required for production asset generation.

The finished experience should evoke the same level of polish found in contemporary AI-powered creative software, emphasizing clarity, elegance, responsiveness, and craftsmanship without sacrificing usability or introducing unnecessary visual noise.

____


Phase 14 — AI-Assisted Watch Annotation & Boundary Detection

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