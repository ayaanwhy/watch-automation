// Shared Rotation image operation (Phase 15.1) — available to both Legacy
// and Sandbox. Distinct from EditingHandoffRotate (src/types/ipc.ts,
// electron/services/workflowPreparation.ts): that feature reorients a
// preprocessing output for a specific downstream Editing destination using
// axis-aligned turns (none/cw/ccw/180). This Rotation operation is the
// Sandbox Preprocessing rotate step: clockwise quarter-turns, 0° being the
// identity/default. 90° and 270° swap the canvas width/height; 180° keeps
// it. All are lossless pixel remaps — no transparent corners are ever
// introduced (see electron/services/imageRotation.ts for the transform).
// (Phase 15.1 originally shipped ±45°/±135° here by mistake; the intended
// values are the quarter-turns below.)
export type RotationDegrees = 0 | 90 | 180 | 270

export const ROTATION_OPTIONS: { value: RotationDegrees; label: string }[] = [
  { value: 0, label: '0°' },
  { value: 90, label: '90°' },
  { value: 180, label: '180°' },
  { value: 270, label: '270°' },
]
