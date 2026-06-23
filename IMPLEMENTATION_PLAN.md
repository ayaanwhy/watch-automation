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