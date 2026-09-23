// Sandbox-only preprocessing operation choice (Phase 15.1). Extends
// Legacy's PreprocessOperation concept (../../types/ipc.ts) with a
// Sandbox-exclusive 'none' value: bypasses both background removal and
// upscaling entirely and proceeds straight to Editing via a lightweight
// file copy (see ../../../electron/sandbox/sandboxNonePreprocessing.ts).
// Legacy's own PreprocessOperation type is never modified to add this —
// Legacy has no code path that can construct or accept 'none'.
import type { PreprocessOperation } from '../../types/ipc'

export type SandboxPreprocessOperation = PreprocessOperation | 'none'
