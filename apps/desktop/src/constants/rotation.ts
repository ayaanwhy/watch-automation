// Shared Rotation image operation (Phase 15.1) — available to both Legacy
// and Sandbox. Distinct from EditingHandoffRotate (src/types/ipc.ts,
// electron/services/workflowPreparation.ts): that feature reorients a
// preprocessing output for a specific downstream Editing destination using
// axis-aligned turns (none/cw/ccw/180) that never expand the canvas. This
// Rotation operation instead applies an arbitrary cosmetic angle — 0° is
// the identity/default; 45°, -45°, 135°, -135° all genuinely expand the
// canvas to the rotated bounding box and expose new, transparent corners
// (see electron/services/imageRotation.ts for the actual transform). The
// two features are independent and neither replaces the other.
export type RotationDegrees = 0 | 45 | -45 | 135 | -135

export const ROTATION_OPTIONS: { value: RotationDegrees; label: string }[] = [
  { value: 0, label: '0°' },
  { value: 45, label: '45°' },
  { value: -45, label: '-45°' },
  { value: 135, label: '135°' },
  { value: -135, label: '-135°' },
]
