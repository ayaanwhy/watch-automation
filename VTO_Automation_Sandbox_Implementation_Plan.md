# VTO Automation — Sandbox Integration 

#### **Implementation Plan & Understanding Brief** 

## **How Claude Should Use This Document** 

Do not begin implementation immediately. First inspect the existing repository and compare it against this plan. Then present a technically detailed understanding/pitch covering architecture, affected areas, risks, dependencies, proposed phase order, and ambiguities requiring decisions. Do not invent APIs, processing behavior, or data contracts. 

## **1. Core Principle** 

Legacy Mode and Sandbox Mode are distinct workflows. Legacy Mode must continue working as it does today, apart from explicitly shared image-operation improvements. Sandbox Mode should be isolated, independently handable, and reuse shared infrastructure only where appropriate. 

Target: 

VTO Automation 

- ├── Legacy Mode 

- │   ── Existing Preprocessing├ 

- │   ── Existing Editing workflows├ 

- │   └── Existing review/batch behavior 

- └── Sandbox Mode 

- ── Dashboard├ 

- ── Universal Processing / Configuration├ 

- ── Product-type orchestration├ 

- ── Post Processing├ 

- └── Final Review / Sandbox handoff 

## **2. Scope Boundaries** 

### **2.1 Shared changes** 

- Upscale Factor = None displays the operation as 'Background Removal', not 'Background Removal + Upscaling'. 

- Rotation supports 45°, -45°, 135°, and -135°. 

- Rotated images preserve the entire image, expand to the rotated bounding box, and fill newly exposed areas with transparency. 

### **2.2 Sandbox-only changes** 

- A real None preprocessing operation bypassing both upscaling and background removal and proceeding directly to Editing. 

- Universal Processing configuration and Sandbox batch selection. 

- Automatic-only masking. 

- Multi-product-type orchestration with concurrent product pipelines. 

- Integrated Post Processing. 

- Unified approval/rejection workflow. 

- Sandbox/API/deployment integration and remote processing support. 

### **2.3 Unchanged** 

- Do not redesign the existing Legacy workflow. 

- Do not remove Legacy product-specific Editing separation or Legacy Automatic/Manual masking. 

- Do not make Sandbox depend on the unavailable Watch AI boundary-detection API. Phase 14 remains parked: 14A complete, 14B blocked. 

## **3. Phase 0 — Architecture & Contracts** 

### **Sandbox boundary** 

Create a clean Sandbox workflow boundary without pervasive sandboxMode conditionals. 

### **Sandbox data contract** 

Define an internal batch representation containing batch ID/name, images, SKU, product type, target, measurement information, and supplied metadata. Keep the external wire format behind an adapter. 

### **Processing backend abstraction** 

Support local Python during development and a remote Python/Flask service in deployment. 

### **Deployment boundary** 

Identify Sandbox-only, shared, API/integration, processing, and deployment code so the Sandbox component can eventually be handed over independently. 

### **Future model boundary** 

Provide a sensible seam for upcoming custom Ring/Bracelet segmentation models; do not implement those models as part of this scope. 

## **4. Phase 1 — Shared Image Operations** 

### **4.1 Upscale None** 

When Upscale Factor is None, the displayed operation is simply 'Background Removal'. 

### **4.2 Sandbox None operation** 

Sandbox-only: None → skip Upscaling → skip Background Removal → Editing. 

### **4.3 Rotation** 

Add 45°, -45°, 135°, and -135°. Rotation must preserve all content, expand the canvas to the actual rotated bounding box, and use transparency for newly exposed areas. Do not hardcode output dimensions. 

### **4.4 Intermediate configuration** 

Existing optional Trim / Rotate / Resize configuration remains available in Sandbox Mode. 

## **5. Phase 2 — Sandbox Dashboard & Universal Configuration** 

- Sandbox Dashboard includes Start Automation. 

- Sandbox sidebar has one Editing entry rather than product-specific Editing entries. 

- Universal flow uses Batch Selection instead of Input Folder/Output Folder. 

- Output destination is controlled by Sandbox. 

- Batch Name comes from the selected Sandbox batch; no incremental automatic naming. 

- Target selector is removed; target arrives per SKU-image combination. 

- Detect all product types present and show configuration for each. 

- One screen configures the full chain: Preprocessing → Config → Editing → Config → Post Processing. 

- If practical, use very thin subtle arrows between sections to communicate execution order. 

- Existing optional Trim/Rotate/Resize and other optional settings remain optional. 

## **6. Phase 3 — Sandbox Execution Orchestrator** 

One selected Sandbox batch is one user-facing run. Internally it may contain product-specific sub-pipelines, but these are never presented as separate batches. 

Different product types may execute concurrently. This means product-type parallelism, not unrestricted parallel processing of individual images. Reuse existing safe per-pipeline queue/execution behavior. 

- Preprocessing → Editing → Post Processing runs continuously after Start. 

- Do not show the current image-by-image pipeline detail view. 

- Show overall progress, completed/total images, current stage, useful product context, images/min, and ETA where reliable. 

- Use live images/min to derive a visual speed cue: green = fast, yellow = medium, orange = slow, red = very slow. 

- Define speed thresholds from observed/approved throughput rather than arbitrary assumptions. 

- Only show Final Batch Details after every internal product pipeline completes. 

## **7. Phase 4 — Integrated Post Processing** 

Add these scripts to a dedicated Sandbox post-processing area: 

1. 1. imageResizeNew — Rings and Bracelets 

2. 2. removeShadows — Watches 

3. 3. resizeGems — Gemstones 

4. 4. compressorNew — All product types 

5. 5. autoMCFF — Rings and Bracelets, optional, with input 

6. 6. autoMCForIndividual — All product types, optional 

7. 7. autoMeasurementCalculator — Earrings, optional 

8. 8. makeCompareRB — Rings and Bracelets, new script 

### **7.1 Canonical product orders** 

- Rings: imageResizeNew → compressorNew → makeCompareRB → autoMCFF* 

- Bracelets: imageResizeNew → compressorNew → makeCompareRB → autoMCFF* 

- Earrings: compressorNew → autoMeasurementCalculator* 

- Necklaces: compressorNew 

- Watches: removeShadows → compressorNew 

- Gemstones: resizeGems → compressorNew 

* Optional. The UI may expose toggles, but execution order is fixed by the product pipeline. Compulsory scripts are preselected. 

### **7.2 Compare images** 

Optional scripts operate only on compare images. Rings/Bracelets generate compare via makeCompareRB. Earrings duplicate generated frontImage as compare. Reuse existing canonical output conventions where possible. 

## **8. Phase 5 — Measurement & Product Data Normalization** 

- Normalize inconsistent measurement-script outputs into one internal representation. 

- Width and Height must be consistently represented. 

- Measurements must update the corresponding product data. 

- Normalized product/measurement data must be available to downstream Sandbox integration. 

Inspect actual outputs of autoMCFF, autoMCForIndividual, and autoMeasurementCalculator before deciding parsing/mapping. Do not invent formats. 

## **9. Phase 6 — Final Review, Approval & Rejection** 

### **9.1 Final Batch Details** 

Show only after the full automation run completes. Preserve Side-by-side, Slider, Transparent/White/Black backgrounds, zoom, and existing review functionality. 

### **9.2 Approval** 

Every output image can be approved. Support bulk approval. Example: 200 outputs → 190 approved + 10 rejected. Approved outputs proceed to Sandbox QA Review once the required approval state is satisfied. 

### **9.3 Rejection** 

- Every output image can be rejected/marked for fixing, not only failed or low-confidence outputs. 

- Support multi-image rejection. 

- Require a rejection reason. 

- Provide optional free-text instructions/comments. 

- Editor list comes from Sandbox. 

- Current editor is selected by default; another editor can be selected. 

- Rejected images and metadata are handed into the manual Sandbox workflow. 

### **9.4 Integration boundary** 

Do not recreate the Sandbox allocation/editor system. Provide a clean integration point for rejected images, reasons, instructions, and editor assignment. 

## **10. Phase 7 — Flask/API/Deployment** 

- Automation will ultimately be hosted through a Flask-based deployment/API. 

- Sandbox will receive an API endpoint to invoke/use Automation. 

- Keep external request/response formats behind adapters. 

- Expose environment-specific URLs through configuration/settings rather than source-code edits. 

- Maintain a convenient local Sandbox development entry point, potentially as a separate package/directory/start command; inspect the repo before deciding structure. 

- Make the Sandbox component independently handable/versionable/deployable. 

- Support local processing for development and remote Python processing for deployment behind the same abstraction. 

## **11. Future Model Upgrade Readiness** 

Custom Ring/Bracelet segmentation models are being trained and should be replaceable without redesigning Sandbox Mode. 

## **12. End-to-End Sandbox Lifecycle** 

Sandbox existing lifecycle: Client Onboarding → Temporary Batches → Batch Allocation → Editor's Workspace → Post Processing → QA Review → Push to CMS. 

Automation intercepts at Temporary Batches and automates: Temporary Batch → VTO Automation → Universal Configuration → Preprocessing → Editing → Post Processing → Unified Final Review → Approved outputs to QA Review / Rejected outputs to Manual Editor Workflow → Push to CMS. 

## **13. Architectural Principles** 

- One Sandbox batch is one user-facing run even when internally split by product type. 

- Different product types may execute concurrently; do not introduce unrestricted per-image GPU concurrency. 

- Universal configuration is declarative; orchestration determines actual product-specific execution. 

- Post-processing order is defined by product type, not arbitrary UI ordering. 

- External APIs are isolated behind adapters. 

- Local and remote processing are interchangeable behind a processing-backend abstraction. 

- Sandbox-specific behavior must not contaminate Legacy Mode. 

- Prefer shared infrastructure where genuinely reusable, while maintaining a clean Sandbox deployment boundary. 

- Never speculate about unavailable external APIs. 

## **14. Validation Expectations** 

Before coding, inspect the repository and produce an implementation map: reusable components, new components, data-flow changes, persistence implications, IPC/API boundaries, Python integration, and deployment boundaries. Validate each phase with the project's established TypeScript/build/test checks and preserve known pre-existing test limitations. 

## **15. Required Pre-Implementation Pitch** 

Before making any changes, Claude must present: 

- A restatement of its understanding. 

- A repository-specific architecture proposal. 

- Existing components to reuse versus new components to create. 

- The Sandbox data flow from batch → configuration → product pipelines → post-processing → review → QA/rejection. 

- The local-vs-remote processing/API boundary. 

- How product-type parallelism will work safely. 

- How compare images and measurement normalization fit into the pipeline. 

- How Sandbox can remain independently handable/deployable. 

- Conflicts or risks discovered in the current architecture. 

- Ambiguities requiring user decisions. 

- A proposed phase-by-phase implementation and validation order. 

**HARD RULE:** Do not begin implementation until this understanding/architecture pitch has been reviewed and approved. Do not make speculative external integration changes. 

