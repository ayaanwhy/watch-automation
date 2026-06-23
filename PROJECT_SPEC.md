Watch Processing Automation Tool (WPA)

Overview

The Watch Processing Automation Tool (WPA) automates preparation of watch assets for the Virtual Try-On (VTO) platform. It will initially run as a standalone local application and later be integrated into Sandbox.

Primary objectives:

* Eliminate repetitive Photoshop work.
* Standardize watch sizing and positioning.
* Automate strap compression and shadow generation.
* Export VTO-ready PNG assets.
* Maintain a processing architecture that can later migrate from local execution to Sandbox with minimal changes.

⸻

Technology Stack

Initial Version

* React
* TypeScript
* Node.js
* Vite
* Konva.js
* Sharp
* XLSX parser

Future Sandbox Integration

Sandbox currently uses React + Node.js. WPA should follow the same architecture to simplify future integration.

Key requirement:

* UI layer and processing engine must remain completely independent.
* Processing modules must be reusable in both local and server-side environments.

⸻

Input Requirements

Watch Images

Requirements:

* PNG only
* Transparent background
* Background already removed
* Already trimmed to outermost visible pixel
* One watch per image

Filename format:

SKU.png

Examples:

WT001.png
WT002.png

Spreadsheet

Supported:

* XLSX
* CSV

Required columns:

Column	Purpose
SKU	Matching identifier
Width	Measurement used for scaling
Height	Informational only
Measure By	Dial or Case

Notes:

* Width is always used for calculations.
* Height is display-only.
* Measure By is display-only.

⸻

Workflow

Step 1: Batch Setup

User selects:

* Input image folder
* Measurement spreadsheet
* Output folder

Step 2: SKU Matching

Match image filenames against spreadsheet SKUs.

Display:

* Matched SKUs
* Missing spreadsheet entries
* Missing images

Only matched records proceed.

⸻

Annotation Interface

Layout

Left Panel:

* Square annotation canvas
* Approx. 80vh height
* Watch preview
* Boundary guides

Right Panel:

* SKU
* Width
* Height
* Measure By
* Processing status
* Batch progress
* Controls

Controls

* Previous
* Next
* Submit
* Uniform / Free toggle

⸻

Dial Boundary Annotation

Watch is logically divided into:

[ Left Strap ] [ Dial ] [ Right Strap ]

Two vertical guides determine dial boundaries.

Default positions:

* Left Guide = 20%
* Right Guide = 80%

Guide styling:

* 1–2px width
* Subtle glow
* Draggable

Uniform Mode

Moving one guide moves the opposite guide proportionally.

Free Mode

Guides move independently.

Keyboard Controls

* Left Arrow = -1px
* Right Arrow = +1px
* Shift + Left Arrow = -10px
* Shift + Right Arrow = +10px

⸻

Submission Workflow

When Submit is pressed:

1. Boundary coordinates are saved.
2. Processing begins in the background.
3. User proceeds to the next watch.

Previously submitted watches may be reopened and edited.

Re-submission overwrites previous outputs.

⸻

Processing Pipeline

Standard Canvas

All outputs are generated on:

2000px × 2000px

Transparent background.

⸻

Stage 1: Splicing

Using boundary coordinates:

Split image into:

* Left Strap
* Dial
* Right Strap

⸻

Stage 2: Measurement Scaling

Reference:

2000px = 55mm
1mm = 36.363636px

Formula:

Target Dial Width = (2000 / 55) × Width(mm)

Example:

44mm = 1600px

⸻

Stage 3: Uniform Scaling

Scale the entire watch proportionally until:

Dial Width = Target Dial Width

Requirements:

* Maintain aspect ratio
* Uniform X/Y scaling

⸻

Stage 4: Dial Centering

After scaling:

Move the dial component so its center aligns to:

X = 1000
Y = 1000

The dial becomes the anchor element for all subsequent operations.

⸻

Stage 5: Strap Reconnection

Reconnect:

* Left Strap → Dial
* Right Strap → Dial

No visible gaps should be introduced.

⸻

Stage 6: Strap Compression

The dial must never be distorted after scaling.

Only straps may be compressed.

Compression uses horizontal scaling only.

Example:

Canvas Width = 2000
Dial Width = 1600
Remaining Width = 400
Left Space = 200
Right Space = 200

If:

Left Strap = 600px
Right Strap = 1000px

Then:

Left Strap → compressed to 200px
Right Strap → compressed to 200px

Requirements:

* Dial remains untouched.
* Strap-to-dial seams remain aligned.
* Compression occurs from outer ends toward the dial.
* Final assembly spans the full canvas width.

⸻

Shadow Generation

Apply a Photoshop-equivalent Drop Shadow after assembly.

Shadow settings will be supplied later.

Shadow engine must support:

* X Offset
* Y Offset
* Blur Radius
* Spread
* Opacity
* Color

⸻

Shadow Mask

Apply mask to shadow layer only.

Watch image remains unaffected.

Mask values:

0–180px       = 0%
180–220px     = 0% → 100%
220–1780px    = 100%
1780–1820px   = 100% → 0%
1820–2000px   = 0%

⸻

Export

Output:

* PNG
* Transparent background
* Maximum quality / lossless

Filename:

SKU;frontImage.png

Example:

WT001;frontImage.png

Export directly into the selected output directory.

⸻

Performance Targets

Current:

* 10–20 image batches

Target:

* 500 image batches

Future:

* 2000–3000 image batches

Processing should occur asynchronously so annotation can continue while completed watches are rendered in the background.

⸻

Architecture

Recommended structure:

/src
  /ui
  /annotation
  /processing
    /spliceEngine
    /scalingEngine
    /centeringEngine
    /compressionEngine
    /shadowEngine
    /exportEngine
  /data
    /spreadsheetParser
    /skuMatcher
  /types

Each processing module should be independently testable.

Processing logic must never depend on React components.

⸻

Future Boundary Detection Architecture

Design Requirement

Boundary detection and image processing must remain separate systems.

The processing engine should only require:

* leftBoundary
* rightBoundary

and should not care how those values were produced.

⸻

Boundary Provider Pattern

Workflow:

Image
→ Boundary Provider
→ Boundary Coordinates
→ Processing Engine

Possible providers:

* Manual annotation
* AI prediction
* Computer vision models
* Imported metadata
* Future automation systems

⸻

Boundary Data Contract

Example:

{
  sku: string;
  leftBoundary: number;
  rightBoundary: number;
  boundarySource: string;
}

Possible values:

manual
ai
ai-reviewed

⸻

Version 1: Manual Annotation

Image
→ User places guides
→ Coordinates
→ Processing Engine

⸻

Version 2: AI-Assisted Annotation

Image
→ AI predicts boundaries
→ Guides pre-populated
→ User reviews
→ Processing Engine

User remains the source of truth.

⸻

Version 3: Fully Automated Processing

Batch Images
→ AI predicts boundaries
→ Processing Engine
→ Export

No manual interaction required.

⸻

Version 4: Confidence-Based Processing

Future AI predictions may include:

{
  leftBoundary: number;
  rightBoundary: number;
  confidence: number;
}

High-confidence assets may be processed automatically.

Low-confidence assets may be routed for manual review.

⸻

Architectural Constraint

Future AI integration should only modify the Boundary Provider layer.

The following modules must remain unchanged:

* Splice Engine
* Scaling Engine
* Centering Engine
* Compression Engine
* Shadow Engine
* Export Engine

This separation is a core architectural requirement.