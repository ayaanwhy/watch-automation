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

Phase 9 — AI Boundary Provider Foundation

Goal

Prepare for future automated dial detection.

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

Success Criteria

Processing engine no longer depends on manual annotation.

⸻

Phase 10 — AI-Assisted Annotation

Goal

Allow AI to pre-populate boundary guides.

Deliverables

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

Success Criteria

Users spend significantly less time annotating.

⸻

Phase 11 — Fully Automated Processing

Goal

Support zero-touch batch processing.

Deliverables

Automated Boundary Detection

Generate boundaries automatically.

Confidence Routing

High confidence:

* Auto process

Low confidence:

* Send for review

Batch Automation

Folder
→ Detect
→ Process
→ Export

Success Criteria

Large batches can be processed without manual intervention.