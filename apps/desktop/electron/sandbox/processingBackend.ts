// ProcessingBackend (Phase 15.0) — the seam between Sandbox's (future,
// 15.3) execution orchestrator and the app's real processing primitives.
//
// Per the approved correction: this is NOT a generic dispatch-by-product-
// type function, and LocalProcessingBackend is NOT a main -> IPC -> main
// round trip. It is a direct, typed reuse of the exact runners/functions
// the existing Preprocessing, Ring & Bracelet, and Earring IPC handlers
// already use to do real work (see ../ipc/preprocessHandlers.ts,
// ../ipc/ringBraceletHandlers.ts, ../ipc/earringHandlers.ts — each now
// exports its runner and/or start function specifically so this file can
// call them directly, in-process). ipcMain is never touched here.
//
// Watch has no subprocess runner — Phase 14's capability is boundary
// detection only (detectBoundaries, already main-process-safe and already
// single-flighted, see ../services/boundaryDetection.ts). The rest of a
// Watch job (resolved boundaries -> existing Watch processing engine ->
// output) is headless-orchestration work, deferred to 15.3 per the
// approved implementation order — wiring it here now would mean building
// sandboxWatchRunner.ts's actual execution logic under cover of "just a
// contract," which this phase is explicitly not scoped to do.
//
// Necklace and Gemstone have no pipeline at all (see
// ../../src/sandbox/types/sandboxProduct.ts) and so have no entry here —
// not a stub, not a TODO function, nothing to invent.
import { runner as preprocessRunner } from '../ipc/preprocessHandlers'
import { runner as ringBraceletRunner, startRingBraceletJob } from '../ipc/ringBraceletHandlers'
import { runner as earringRunner, startEarringJob } from '../ipc/earringHandlers'
import { detectBoundaries } from '../services/boundaryDetection'
import type { SubprocessRunner } from '../services/subprocessRunner'
import type { PreprocessStartPayload, RingBraceletStartPayload, EarringStartPayload } from '../../src/types/ipc'

export interface ProcessingBackend {
  preprocessing: SubprocessRunner<PreprocessStartPayload>
  // Backs both 'ring' and 'bracelet' SandboxProductTypes — same underlying
  // pipeline, differentiated only by payload.product, exactly as Legacy
  // already does (see ringBraceletHandlers.ts's RingBraceletStartPayload).
  ringBracelet: SubprocessRunner<RingBraceletStartPayload>
  earring: SubprocessRunner<EarringStartPayload>
  // Watch's only currently-reusable primitive — see file header for why
  // this is intentionally not a full job runner yet.
  detectWatchBoundaries: typeof detectBoundaries
}

export const localProcessingBackend: ProcessingBackend = {
  preprocessing: preprocessRunner,
  ringBracelet: { start: startRingBraceletJob, cancel: ringBraceletRunner.cancel },
  earring: { start: startEarringJob, cancel: earringRunner.cancel },
  detectWatchBoundaries: detectBoundaries,
}
