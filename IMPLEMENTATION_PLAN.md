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

Polish the Editing workflow so operators have a clear, intuitive experience throughout asset generation and review.

Scope

* Improve progress reporting for long-running operations.
* Surface masking confidence and review indicators more clearly.
* Replace the Editing product dropdown with segmented/tile selection.
* Improve review interactions and generated asset comparison.
* Refine the Editing UI to match the quality of the Watch workflow.

Deliverable:

Editing provides a polished, informative workflow with clear feedback during generation and review.

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

Deliverables

Performance Optimization

Review and optimize:

* Memory usage
* CPU utilization
* GPU utilization
* Image processing throughput
* Startup time
* Large batch performance

⸻

Processing Pipeline Optimization

Improve:

* Parallelism
* Caching
* Temporary file handling
* Queue scheduling
* Batch throughput

Reduce unnecessary disk I/O wherever practical.

⸻

Robustness

Improve recovery from:

* Interrupted batches
* Application crashes
* Python failures
* Corrupt images
* Missing files

Ensure users can safely resume work whenever possible.

⸻

Logging & Diagnostics

Expand diagnostic tooling.

Provide:

* Structured logs
* Performance metrics
* Memory snapshots
* Error reporting
* Batch diagnostics

Support future troubleshooting without affecting normal users.

⸻

Architecture Cleanup

Review the codebase for maintainability.

Refine:

* IPC boundaries
* Shared types
* State management
* Folder organization
* Plugin interfaces
* Module responsibilities

Remove temporary implementations introduced during earlier phases.

⸻

Plugin System Improvements

Strengthen extensibility.

Prepare for future modules by improving:

* Plugin discovery
* Shared interfaces
* Configuration
* Registration
* Version compatibility

⸻

Success Criteria

The application operates reliably on large real-world datasets across multiple product workflows, remains responsive during extended processing sessions, and provides a stable foundation for the AI-assisted annotation work in Phase 12.

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